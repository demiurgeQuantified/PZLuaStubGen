import type ast from 'luaparse'
import type { LuaBlock } from './lua-block'
import type { LuaFile } from './lua-file'

export type LuaBlockNode =
    | ast.Chunk
    | ast.FunctionDeclaration
    | ast.IfClause
    | ast.ElseifClause
    | ast.ElseClause
    | ast.ForNumericStatement
    | ast.ForGenericStatement
    | ast.WhileStatement
    | ast.DoStatement
    | ast.RepeatStatement
export type LuaCallExpression = ast.CallExpression | ast.StringCallExpression | ast.TableCallExpression
export type LuaSubdirectory = 'client' | 'server' | 'shared'
export type LuaAssignmentType = 'local' | 'global' | 'local-reassign' | 'set-field' | 'parameter' | 'generic-for' | 'numeric-for'
export type LuaLHS = ast.Identifier | ast.MemberExpression | ast.IndexExpression
export type LuaRHS = ast.Expression | undefined
export type LuaFileRecord = Record<string, LuaFile>
export type LuaElement = LuaAssignment | LuaCall | LuaBlock

export interface AnalyzerOptions {
    inputDirectory: string
    outputDirectory?: string
    verbose: boolean
}

export interface LuaElementBase<TType> {
    type: TType
}

export interface LuaAssignment extends LuaElementBase<'assignment'> {
    assignTypes: LuaAssignmentType[]
    lhs: LuaLHS[]
    rhs: LuaRHS[]
}

export interface LuaCall extends LuaElementBase<'call'> {
    expression: ast.Expression
    arguments: ast.Expression[]
}

export interface LuaLocal {
    name: string
    assignments: LuaAssignment[]
}
