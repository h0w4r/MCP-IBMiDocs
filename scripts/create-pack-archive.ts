import path from "node:path";
import { archiveDataPack } from "../src/pack/dataPack.js";

const packDir = process.argv[2] ?? path.resolve("data", "pack");
const outFile = process.argv[3] ?? path.resolve("dist", "ibmi-docs-pack.tgz");
const result = await archiveDataPack({ packDir, outFile });
console.log(JSON.stringify(result, null, 2));
