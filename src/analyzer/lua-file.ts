import { LuaBlock } from './lua-block'
import type { LuaBlockNode } from './types'

export class LuaFile extends LuaBlock {
    private globalsSet: Set<string>
    private globalDependencies: Set<string>
    private fileDependencies: Set<string>

    constructor(node: LuaBlockNode) {
        super(node)
        this.globalsSet = new Set()
        this.globalDependencies = new Set()
        this.fileDependencies = new Set()
    }

    addFileDependency(name: string) {
        this.fileDependencies.add(LuaBlock.getFileIdentifier(name))
    }

    addGlobalDependency(name: string) {
        this.globalDependencies.add(name)
    }

    addGlobalSet(name: string) {
        this.globalsSet.add(name)
    }

    finalize(): this {
        // if we set a global, don't consider it a dependency
        for (const dep of this.globalsSet) {
            this.globalDependencies.delete(dep)
        }

        return this
    }
}
