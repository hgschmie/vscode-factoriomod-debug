import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { forkTest } from "./util.ts";

const cli = path.resolve(import.meta.dirname, "../dist/fmtk-cli.js");

await test("EmmyLua preserves named integer contracts without inventing define values", async ()=>{
	const root = path.resolve(import.meta.dirname, "../build/test-work/docs-defines");
	await mkdir(root, {recursive: true});
	const dir = await mkdtemp(path.join(root, "case-"));
	const values = [{name: "first", order: 42, description: "First documented member."}, {name: "second-value", order: 7, description: "Second member."}];
	const runtime = {application: "factorio", application_version: "2.1.23", api_version: 6, stage: "runtime",
		classes: [], events: [], concepts: [], global_objects: [], global_functions: [],
		defines: ["direction", "transport_line", "events", "unrelated"].map((name, order)=>({name, order, description: name, values}))};
	runtime.defines.push({name: "prototypes", order: 4, description: "Prototype values", values});
	const protos = {application: "factorio", application_version: "2.1.23", api_version: 6, stage: "prototype", types: [], prototypes: []};
	await writeFile(path.join(dir, "runtime.json"), JSON.stringify(runtime));
	await writeFile(path.join(dir, "prototype.json"), JSON.stringify(protos));
	const outputs:Record<string, string> = {};
	for (const target of ["default", "luals", "emmylua"]) {
		await forkTest(cli, ["docs", path.join(dir, target), "--docs", path.join(dir, "runtime.json"), "--protos", path.join(dir, "prototype.json"), ...(target === "default" ? [] : ["--target", target])]);
		outputs[target] = await readFile(path.join(dir, target, "factorio/library/runtime-api/defines.lua"), "utf8");
	}
	assert.equal(outputs.default, outputs.luals);
	for (const name of ["direction", "transport_line"]) {
		assert.ok(outputs.emmylua.includes(`---@enum defines.${name}\n`));
		assert.ok(outputs.emmylua.includes(`---@alias defines.${name}.first integer\n---@type defines.${name}.first\nfirst=nil,`));
		assert.ok(outputs.emmylua.includes(`---@alias defines.${name}.second_value integer\n---@type defines.${name}.second_value\n['second-value']=nil,`));
		assert.ok(outputs.luals.includes(`---@class defines.${name}.first\nfirst={},`));
		assert.ok(!outputs.emmylua.includes(`---@class defines.${name}.first`));
	}
	for (const name of ["events", "unrelated"]) {
		assert.ok(outputs.emmylua.includes(`---@class defines.${name}.first\nfirst={},`));
	}
	assert.match(outputs.emmylua, /First documented member\./);
	assert.match(outputs.emmylua, /defines\.prototypes=\{\n(?:[^}]*\n)*?first=0,/);
	assert.doesNotMatch(outputs.emmylua, /(?:first|second-value)=(?:42|7),/);
});
