export { BaseAgent, extractTag } from "./base.js";
export { ArchitectAgent } from "./architect.js";
export { RendererAgent } from "./renderer.js";
export { PageRendererAgent } from "./page-renderer.js";
export { ShellRendererAgent } from "./shell-renderer.js";
export { ValidatorAgent } from "./validator.js";

import type { Agent } from "../core/types.js";
import { ArchitectAgent } from "./architect.js";
import { RendererAgent } from "./renderer.js";
import { ValidatorAgent } from "./validator.js";

/** Returns the default pipeline: architect → renderer → validator */
export function createDefaultAgents(): Agent[] {
  return [new ArchitectAgent(), new RendererAgent(), new ValidatorAgent()];
}
