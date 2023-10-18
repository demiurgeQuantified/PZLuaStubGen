import { LuaBlock } from './lua-block'
import type { Analyzer } from '.'
import type { LuaBlockNode } from './types'

export class LuaFile extends LuaBlock {
    name: string
    subdirectory: string
    globalsSet: Set<string>
    globalDependencies: Set<string>
    fileDependencies: Set<string>

    constructor(node: LuaBlockNode, subdirectory: string, name: string, analyzer: Analyzer) {
        super(node, analyzer)
        this.name = name
        this.subdirectory = subdirectory
        this.globalsSet = new Set()
        this.globalDependencies = new Set()
        this.fileDependencies = new Set()
    }

    addFileDependency(name: string) {
        if (this.analyzer.pass === 'dependency-resolution') {
            this.fileDependencies.add(name)
        }
    }

    addGlobalDependency(name: string) {
        if (this.analyzer.pass === 'dependency-resolution') {
            this.globalDependencies.add(name)
        }
    }

    addGlobalSet(name: string) {
        if (this.analyzer.pass === 'dependency-resolution') {
            this.globalsSet.add(name)
        }
    }

    cleanup(): this {
        // if we set a global, don't consider it a dependency
        for (const dep of this.globalsSet) {
            this.globalDependencies.delete(dep)
        }

        // clear intermediate info to avoid memory overuse
        delete this.parent
        this.children = []
        this.elements = []
        this.returns = []
        this.locals = {}

        return this
    }
}
