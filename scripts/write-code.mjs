import { fileURLToPath } from "node:url";
import { issueWriteCode } from "../server/project-permissions.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = issueWriteCode(root);
console.log("One-time project write approval code (valid 10 minutes):");
console.log(result.code);
console.log("Use only on the Codex Remote Web project permission form.");
