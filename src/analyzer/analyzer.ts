import fs from 'fs'
import path from 'path'
import ast from 'luaparse'
import type { AnalyzerOptions, LuaCallExpression, LuaFileRecord, LuaLHS, LuaRHS, LuaSubdirectory } from './types'
import { LuaFile } from './lua-file'
import { LuaBlock } from './lua-block'


const numericRegexp = /(\d)[lf]([,;)\s])/g
const sanitizeLua = (source: string): string => {
    // replacement based on PipeWrench-Modeler
    // handles Kahlua-specific number quirks
    source = source.replace(numericRegexp, '$1$2')

    // ISZoneDisplay edge case
    source = source.replace(/\\%/, ' %')

    return source
}


export class Analyzer {
    private errors: string[]
    private options: AnalyzerOptions
    private fileBlock?: LuaFile
    private files: Record<LuaSubdirectory, LuaFileRecord>
    private stack: LuaBlock[]

    constructor(options: AnalyzerOptions) {
        this.options = options
        this.errors = []
        this.stack = []
        this.files = {
            client: {},
            server: {},
            shared: {},
        }
    }

    async analyze(): Promise<Record<LuaSubdirectory, LuaFileRecord>> {
        this.errors = []
        this.stack = []
        this.files = {
            client: {},
            server: {},
            shared: {},
        }

        const inDirPath = this.options.inputDirectory
        const gameFileDirectories: LuaSubdirectory[] = ['shared', 'server', 'client']
        for (const subdir of gameFileDirectories) {
            const files: LuaFileRecord = {}
            this.files[subdir] = files
            await this.readDirectory(path.join(inDirPath, subdir), files)
        }

        this.fileBlock = undefined

        // temporary return. TODO: create proper type
        return this.getDebugOutput()
    }

    getDebugOutput() {
        const files = this.files
        for (const fileRecords of Object.values(files)) {
            for (const fileBlock of Object.values(fileRecords)) {
                fileBlock.prepareForDebug()
            }
        }

        return files
    }

    private async readDirectory(startDirPath: string, fileMap: Record<string, LuaFile>) {
        const stack = [startDirPath]

        const pathStart = startDirPath.length + path.sep.length
        while (stack.length > 0) {
            const dirPath = stack.pop()!
            try {
                const dir = await fs.promises.opendir(dirPath)

                // iterator handles closing the directory handle
                for await (const fileOrDirectory of dir) {
                    const childPath = path.join(dirPath, fileOrDirectory.name)
                    if (fileOrDirectory.isDirectory()) {
                        stack.push(childPath)
                    } else if (fileOrDirectory.isFile() && path.extname(childPath) === '.lua') {
                        const block = await this.readFile(childPath)
                        if (block) {
                            fileMap[LuaBlock.getFileIdentifier(childPath.slice(pathStart))] = block
                        }
                    }
                }
            } catch (e) {
                this.errors.push(`Failed to scan directory '${dirPath}: ${e}'`)
            }
        }
    }

    private async readFile(filePath: string): Promise<LuaFile | undefined> {
        let content
        try {
            const file = await fs.promises.open(filePath)
            content = await file.readFile('utf-8')
            await file.close()
        } catch (e) {
            this.errors.push(`Failed to read file '${filePath}': ${e}`)
            return
        }

        try {
            return this.readLua(content)
        } catch (e) {
            this.errors.push(`Failed to analyze file '${filePath}': ${e}`)
        }
    }

    private readLua(content: string): LuaFile {
        const tree = ast.parse(sanitizeLua(content), {
            locations: true,
            comments: false,
            // Kahlua is closer to 5.1, but this gets around the 'break' issue in luaparse
            luaVersion: '5.2',
        })

        this.fileBlock = new LuaFile(tree)
        this.stack.push(this.fileBlock)

        while (this.stack.length > 0) {
            const block = this.stack.pop()!

            for (const statement of block.getBody()) {
                switch (statement.type) {
                    case 'LocalStatement':
                        this.readLocalStatement(statement, block)
                        break
                    case 'AssignmentStatement':
                        this.readAssignStatement(statement, block)
                        break
                    case 'CallStatement':
                        this.readExpression(statement.expression, block)
                        break
                    case 'ReturnStatement':
                        for (const arg of statement.arguments) {
                            this.readExpression(arg, block)
                        }

                        block.addReturn(statement)
                        break
                    case 'IfStatement':
                        for (const clause of statement.clauses) {
                            this.stack.push(new LuaBlock(clause, block))
                        }
                        break
                    case 'FunctionDeclaration':
                        this.stack.push(new LuaBlock(statement, block))
                        break
                    case 'DoStatement':
                    case 'WhileStatement':
                    case 'RepeatStatement':
                        this.stack.push(new LuaBlock(statement, block))
                        break
                    case 'ForNumericStatement':
                        this.stack.push(new LuaBlock(statement, block))
                        break
                    case 'ForGenericStatement':
                        for (const iter of statement.iterators) {
                            this.readExpression(iter, block)
                        }

                        this.stack.push(new LuaBlock(statement, block))
                        break
                }
            }
        }

        return this.fileBlock.finalize()
    }

    private readExpression(expression: ast.Expression, block: LuaBlock) {
        switch (expression.type) {
            case 'Identifier':
                if (!block.getLocal(expression.name)) {
                    this.addGlobalReference(expression)
                }
                break
            case 'MemberExpression':
                this.readExpression(expression.base, block)
                break
            case 'IndexExpression':
                this.readExpression(expression.base, block)
                this.readExpression(expression.index, block)
                break
            case 'CallExpression':
                if (!this.tryReadRequire(expression)) {
                    this.readExpression(expression.base, block)
                    for (const arg of expression.arguments) {
                        this.readExpression(arg, block)
                    }

                    this.readCallExpression(expression, block)
                }
                break
            case 'TableCallExpression':
                this.readExpression(expression.base, block)
                this.readExpression(expression.arguments, block)
                break
            case 'StringCallExpression':
                if (!this.tryReadRequire(expression)) {
                    this.readExpression(expression.base, block)
                    this.readExpression(expression.argument, block)
                }
                break
            case 'TableConstructorExpression':
                for (const field of expression.fields) {
                    this.readExpression(field.value, block)
                    if (field.type === 'TableKey') {
                        this.readExpression(field.key, block)
                    }
                }
                break
            case 'FunctionDeclaration':
                this.stack.push(new LuaBlock(expression, block))
                break
            case 'UnaryExpression':
                this.readExpression(expression.argument, block)
                break
            case 'BinaryExpression':
            case 'LogicalExpression':
                this.readExpression(expression.left, block)
                this.readExpression(expression.right, block)
                break
        }
    }

    private readAssignStatement(statement: ast.AssignmentStatement, block: LuaBlock) {
        const [lhs, rhs] = this.prepareAssignment(statement, block)
        block.addAssignment(lhs, rhs)
    }

    private readCallExpression(expression: ast.CallExpression, block: LuaBlock) {
        // add calls for type tracking
        block.addCall(expression)
    }

    private readLocalStatement(statement: ast.LocalStatement, block: LuaBlock) {
        const [lhs, rhs] = this.prepareAssignment(statement, block)
        block.addLocalAssignment(lhs as ast.Identifier[], rhs)
    }

    private prepareAssignment(statement: ast.LocalStatement | ast.AssignmentStatement, block: LuaBlock): [LuaLHS[], LuaRHS[]] {
        const lhs: LuaLHS[] = []
        const rhs: LuaRHS[] = []

        for (const [i, variable] of statement.variables.entries()) {
            const init = statement.init[i]
            lhs.push(variable)
            rhs.push(init)

            if (init) {
                // read initializers first to accurately track globals
                this.readExpression(init, block)
            }
        }

        // handle references for set-field
        for (const variable of statement.variables) {
            if (variable.type !== 'Identifier') {
                this.readExpression(variable.base, block)
            }
        }

        return [lhs, rhs]
    }

    private addGlobalReference(ident: ast.Identifier) {
        this.fileBlock!.addGlobalDependency(ident.name)
    }

    private tryReadRequire(expression: LuaCallExpression) {
        if (expression.type === 'TableCallExpression') return false
        if (expression.base.type !== 'Identifier') return false
        if (expression.base.name !== 'require') return false

        let arg
        if (expression.type === 'StringCallExpression') {
            arg = expression.argument
        } else {
            arg = expression.arguments.at(1)
        }

        if (!arg || arg.type !== 'StringLiteral') return false

        let requireName
        if (arg.value) {
            requireName = arg.value
        } else if (arg.raw) {
            requireName = arg.raw.slice(1, -1)
        }

        if (!requireName) return false

        this.fileBlock!.addFileDependency(requireName)
        return true
    }
}
