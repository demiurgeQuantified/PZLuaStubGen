import fs from 'fs'
import path from 'path'
import { Analyzer } from './analyzer'
import type { AnalyzerOptions } from './types'

export { Analyzer } from './analyzer'
export type { AnalyzerOptions } from './types'

export const analyze = async (options: AnalyzerOptions) => {
    const analyzer = new Analyzer(options)
    const result = await analyzer.analyze()

    const debugOutput = JSON.stringify(result, (_, value) => (value instanceof Set ? [...value] : value))
    if (options.outputDirectory) {
        const outputPath = path.join(options.outputDirectory, 'out.json')
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
        await fs.promises.writeFile(outputPath, debugOutput, { flag: 'w' })
    } else {
        console.dir(JSON.parse(debugOutput), { depth: null, color: true })
    }
}
