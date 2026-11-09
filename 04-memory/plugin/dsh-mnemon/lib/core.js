import { t as provideMemoryRuntime } from "./runtime-0u6dOiF9.js";
//#region src/core/plugin.ts
const name = "dsh-mnemon-core";
const provide = ["mnemonMemory"];
const inject = [];
/** No built-in Source, Provider, filesystem, settings, tools, or Web dependency. */
function apply(context) {
	provideMemoryRuntime(context);
}
//#endregion
export { apply, inject, name, provide };
