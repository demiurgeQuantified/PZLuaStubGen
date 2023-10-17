import type ast from 'luaparse'
import type { LuaFile } from './lua-file'
import type {
    LuaAssignment,
    LuaAssignmentType,
    LuaBlockNode,
    LuaCall,
    LuaElement,
    LuaElementBase,
    LuaLHS,
    LuaLocal,
    LuaRHS
} from './types'

export class LuaBlock implements LuaElementBase<'block'> {
    type: 'block'
    private node: LuaBlockNode
    private parent?: LuaBlock
    private children: LuaBlock[]
    private locals: Record<string, LuaLocal>
    private elements: LuaElement[]
    private returns: ast.ReturnStatement[]

    constructor(node: LuaBlockNode, parent?: LuaBlock) {
        this.type = 'block'
        this.node = node
        this.children = []
        this.locals = {}
        this.elements = []
        this.returns = []

        switch (node.type) {
            case 'FunctionDeclaration':
                this.addBlockLocals(node.parameters, [], 'parameter')
                if (parent && node.isLocal && node.identifier?.type === 'Identifier') {
                    parent.addLocalAssignment([node.identifier], [node], this.getLocal(node.identifier.name))
                }
                break
            case 'ForGenericStatement':
                this.addBlockLocals(node.variables, node.iterators, 'generic-for')
                break
            case 'ForNumericStatement':
                this.addBlockLocals([node.variable], [node.start, node.end, node.step ?? undefined], 'numeric-for')
                break
        }

        if (parent) {
            parent.addChild(this)
        }
    }

    static getFileIdentifier(name: string): string {
        if (name.endsWith('.lua')) name = name.slice(0, -4)
        return name.replace(/[\\.]/g, '/')
    }

    // TODO: remove
    prepareForDebug() {
        delete this.parent

        for (const child of this.children) {
            child.prepareForDebug()
        }
    }

    addChild(child: LuaBlock) {
        child.parent = this
        this.children.push(child)
        this.elements.push(child)
    }

    addBlockLocals(expressions: (ast.Identifier | ast.VarargLiteral)[], rhs: LuaRHS[], type: LuaAssignmentType) {
        const expr = []
        for (const param of expressions) {
            if (param.type === 'VarargLiteral') continue
            expr.push(param)
        }

        const assignment: LuaAssignment = {
            type: 'assignment',
            assignTypes: expr.map(_ => type),
            lhs: expr,
            rhs: rhs,
        }

        for (const ident of expr) {
            const local: LuaLocal = {
                name: ident.name,
                assignments: [ assignment ],
            }

            this.locals[ident.name] = local
        }

        this.elements.push(assignment)
        return assignment
    }

    addLocalAssignment(lhs: ast.Identifier[], rhs: LuaRHS[], existingLocal?: LuaLocal) {
        const assignment: LuaAssignment = {
            type: 'assignment',
            assignTypes: lhs.map(_ => 'local'),
            lhs,
            rhs,
        }

        if (existingLocal && lhs.length === 1 && rhs.length === 1) {
            assignment.assignTypes = ['local-reassign']
            existingLocal.assignments.push(assignment)
        } else {
            for (const ident of lhs) {
                const local: LuaLocal = {
                    name: ident.name,
                    assignments: [ assignment ],
                }
    
                this.locals[ident.name] = local
            }
        }

        this.elements.push(assignment)
        return assignment
    }

    /**
     * Records an assignment.
     * This will resolve to either a global, local-reassign, or set-field assignment.
     * @param lhs The left hand side of the assignment.
     * @param rhs The right hand side of the assignment.
     * @returns The assignment record.
     */
    addAssignment(lhs: LuaLHS[], rhs: LuaRHS[]) {
        const assignment: LuaAssignment = {
            type: 'assignment',
            assignTypes: lhs.map(_ => 'global'),
            lhs,
            rhs,
        }

        const file = this.getTopAncestor()
        for (const [i, left] of lhs.entries()) {
            if (left.type !== 'Identifier') {
                assignment.assignTypes[i] = 'set-field'
                continue
            }

            const local = this.getLocal(left.name)
            if (local) {
                local.assignments.push(assignment)
                assignment.assignTypes[i] = 'local-reassign'
            } else {
                file.addGlobalSet(left.name)
            }
        }

        this.elements.push(assignment)
        return assignment
    }

    addCall(expression: ast.CallExpression) {
        const call: LuaCall = {
            type: 'call',
            expression: expression.base,
            arguments: expression.arguments,
        }

        this.elements.push(call)
        return call
    }

    addReturn(statement: ast.ReturnStatement) {
        this.returns.push(statement)
    }

    getTopAncestor(): LuaFile {
        let ancestor
        let node: LuaBlock = this
        while (node) {
            ancestor = node.parent
            if (!ancestor?.parent) break

            node = ancestor
        }

        return (ancestor ?? this) as LuaFile
    }

    getBody() {
        return this.node.body
    }

    getElements() {
        return this.elements
    }

    getNode() {
        return this.node
    }

    getLocal(name: string) {
        let node: LuaBlock | undefined = this
        while (node) {
            if (node.locals[name]) {
                return node.locals[name]
            }

            node = node.parent
        }
    }
}
