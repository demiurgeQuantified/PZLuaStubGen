import fs from 'fs'
import path from 'path'
import ast from 'luaparse'

import { LuaFile } from './lua-file'
import { LuaBlock } from './lua-block'
import type {
    AnalyzerOptions,
    LuaBlockNode,
    LuaCallExpression,
    LuaFileRecord,
    LuaGameSubdirectory,
    LuaLHS,
    LuaRHS
} from './types'


type AnalysisPass = 'dependency-resolution' | 'type-resolution'

const numericRegexp = /(\d)[lf]([,;)\s])/g
const gameFileDirectories: LuaGameSubdirectory[] = ['shared', 'server', 'client']
const sanitizeLua = (source: string): string => {
    // replacement based on PipeWrench-Modeler
    // handles Kahlua-specific number quirks
    source = source.replace(numericRegexp, '$1$2')

    // ISZoneDisplay edge case
    source = source.replace(/\\%/, ' %')

    return source
}


export class Analyzer {
    pass: AnalysisPass
    private errors: string[]
    private options: AnalyzerOptions
    private curFileBlock?: LuaFile
    private stack: LuaBlock[]
    private globalSetters: Record<string, Set<string>>
    private fileAliases: Record<string, Set<string>>

    constructor(options: AnalyzerOptions) {
        this.pass = 'dependency-resolution'
        this.options = options
        this.errors = []
        this.stack = []
        this.fileAliases = {}
        this.globalSetters = {}
    }

    async analyze() {
        const files = await this.resolveDependencies()

        // temporary return. TODO: create proper type
        return this.getDebugOutput(this.resolveTypes(files))
    }

    async resolveDependencies(): Promise<LuaFile[]> {
        this.startPass('dependency-resolution')
        const files: Record<LuaGameSubdirectory, LuaFileRecord> = {
            client: {},
            server: {},
            shared: {},
        }

        // read all files
        const inDirPath = this.options.inputDirectory
        for (const subdir of gameFileDirectories) {
            await this.readDirectory(path.join(inDirPath, subdir), subdir, files[subdir])
        }

        // "loose" dependencies are secondary dependencies based on global references
        const looseDeps: Record<string, Set<string>> = {}

        const getFile = (name: string): LuaFile | undefined => {
            for (const subdir of gameFileDirectories) {
                const rec = files[subdir]
                if (rec[name]) {
                    return rec[name]
                }
            }
        }
    
        const getDependencyIdentifier = (name: string): string | undefined => {
            if (getFile(name)) {
                return name
            }
    
            if (this.fileAliases[name]) {
                const aliasSet = this.fileAliases[name]
                if (aliasSet.size > 1) {
                    // TODO: verbose warning?
                }
    
                const [first] = aliasSet
                return first
            }
        }

        // modify dependencies
        for (const subdir of gameFileDirectories) {
            for (const [name, file] of Object.entries(files[subdir])) {
                looseDeps[name] = new Set()
                file.globalDependencies.forEach(x => {
                    const setters = this.globalSetters[x]
                    if (!setters || setters.size === 0) {
                        // if a global is never set, remove it as a dependency
                        file.globalDependencies.delete(x)
                    } else {
                        // add the first setter as a loose dependency
                        const [setter] = setters
                        looseDeps[name].add(setter)
                    }
                })

                file.globalDependencies.clear()
            }
        }

        // determine order of analysis
        const analysisOrder = new Set<string>() // sets are ordered
        const seen = new Set<string>()
        for (const subdir of gameFileDirectories) {
            const rec = files[subdir]
            // game loads files in case-insensitive ASCII order
            // sorting in reverse order to treat as stack
            const keys = Object.keys(rec).sort((a, b) => {
                return a.toLocaleUpperCase() < b.toLocaleUpperCase() ? 1 : -1
            })

            if (keys.length === 0) continue

            const deque = [ keys.pop()! ]
            while (deque.length > 0) {
                const key = deque.shift()!
                seen.add(key)

                const depsToAdd = []
                let file
                if (!analysisOrder.has(key)) {
                    file = getFile(key)
                }

                if (!file) {
                    const nextKey = keys.pop()
                    if (nextKey) {
                        deque.push(nextKey)
                    }

                    continue
                }

                for (const dep of file.fileDependencies) {
                    const depName = getDependencyIdentifier(dep)
                    if (depName && !analysisOrder.has(depName)) {
                        depsToAdd.push(depName)
                    }
                }

                for (const dep of looseDeps[key]) {
                    const depName = getDependencyIdentifier(dep)
                    if (!depName || seen.has(depName) || analysisOrder.has(depName)) continue
                    depsToAdd.push(depName)
                }

                if (depsToAdd.length > 0) {
                    // add dependencies to the start of the queue, followed by this element
                    deque.unshift(key)
                    deque.unshift(...depsToAdd)
                } else {
                    // add this element to the analysis order
                    analysisOrder.add(key)

                    //add the next element to the end of the queue
                    const nextKey = keys.pop()
                    if (nextKey) {
                        deque.push(nextKey)
                    }
                }
            }
        }

        return [...analysisOrder].map(k => {
            const file = getFile(k)!
            file.fileDependencies.clear()
            return file
        })
    }

    resolveTypes(files: LuaFile[]): LuaFile[] {
        this.startPass('type-resolution')

        for (const file of files) {
            this.processFile(file)
            file.cleanup()
        }

        return files
    }

    getDebugOutput(files: LuaFile[]) {
        for (const fileBlock of files) {
            fileBlock.prepareForDebug()
        }

        return files
    }

    private getFileIdentifier(name: string): string {
        if (name.endsWith('.lua')) name = name.slice(0, -4)
        return name.replace(/[\\.]/g, '/')
    }

    private startPass(pass: AnalysisPass) {
        this.pass = pass
        this.globalSetters = {}
    }

    private async readDirectory(startDirPath: string, subdir: LuaGameSubdirectory, fileMap: LuaFileRecord) {
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
                        const name = this.getFileIdentifier(childPath.slice(pathStart))
                        const block = await this.readFile(childPath, subdir, name)
                        if (!block) continue
                    
                        fileMap[name] = block
                        let partialName = name
                        let slash = partialName.indexOf('/')
                        while (slash !== -1) {
                            partialName = partialName.slice(slash + 1)
                            if (!this.fileAliases[partialName]) {
                                this.fileAliases[partialName] = new Set()
                            }

                            this.fileAliases[partialName].add(name)
                            slash = partialName.indexOf('/')
                        }
                    }
                }
            } catch (e) {
                this.errors.push(`Failed to scan directory '${dirPath}: ${e}'`)
            }
        }
    }

    private async readFile(filePath: string, subdir: LuaGameSubdirectory, name: string): Promise<LuaFile | undefined> {
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
            const tree = ast.parse(sanitizeLua(content), {
                locations: true,
                comments: false,
                // Kahlua is closer to 5.1, but this gets around the 'break' issue in luaparse
                luaVersion: '5.2',
            })

            const file = this.processFile(new LuaFile(tree, subdir, name, this)).cleanup()
            file.globalsSet.forEach(x => {
                if (!this.globalSetters[x]) {
                    this.globalSetters[x] = new Set()
                }

                this.globalSetters[x].add(name)
            })

            return file
        } catch (e) {
            this.errors.push(`Failed to analyze file '${filePath}': ${e}`)
        }
    }

    private processFile(file: LuaFile): LuaFile {
        this.curFileBlock = file
        this.stack = [ file ]

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
                            this.pushBlock(clause, block)
                        }
                        break
                    case 'FunctionDeclaration':
                        this.pushBlock(statement, block)
                        break
                    case 'DoStatement':
                    case 'WhileStatement':
                    case 'RepeatStatement':
                        this.pushBlock(statement, block)
                        break
                    case 'ForNumericStatement':
                        this.pushBlock(statement, block)
                        break
                    case 'ForGenericStatement':
                        for (const iter of statement.iterators) {
                            this.readExpression(iter, block)
                        }

                        this.pushBlock(statement, block)
                        break
                }
            }
        }

        this.curFileBlock = undefined
        return file
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
                this.pushBlock(expression, block)
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

    private pushBlock(node: LuaBlockNode, parent?: LuaBlock) {
        this.stack.push(new LuaBlock(node, this, parent))
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
        this.curFileBlock!.addGlobalDependency(ident.name)
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

        this.curFileBlock!.addFileDependency(this.getFileIdentifier(requireName))
        return true
    }
}
