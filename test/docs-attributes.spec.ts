import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { forkTest, forkTestFails } from "./util.ts";

const cli = path.resolve(import.meta.dirname, "../dist/fmtk-cli.js");
const member = (name:string, read_type?:ApiType, write_type?:ApiType, optional = false):ApiAttribute=>({name, read_type, write_type, optional, order: 0, description: `Description for ${name}.`});
const struct = (attributes:ApiAttribute[]):ApiType=>({complex_type: "LuaStruct", attributes});

async function fixture(runtimeOverrides:Partial<ApiDocs> = {}, types:ProtoConcept[] = []) {
	const root = path.resolve(import.meta.dirname, "../build/test-work/docs-attributes");
	await mkdir(root, {recursive: true});
	const dir = await mkdtemp(path.join(root, "case-"));
	const runtime = {application: "factorio", application_version: "2.1.20", api_version: 6, stage: "runtime",
		events: [], defines: [], concepts: [], global_objects: [], global_functions: [],
		classes: [{name: "Sample", order: 0, description: "Sample", abstract: false, methods: [], operators: [], attributes: [
			member("value", "ReadValue", "WriteValue", true), member("equal", "string", "string"),
			member("readonly", "string"), member("writeonly", undefined, "number"),
			member("nested", struct([member("field", "number", "string")])),
			member("converted", struct([member("out", "number")]), struct([member("input", "string")])),
		]}, {name: "LuaSettings", order: 1, description: "Overlay", abstract: false, methods: [], operators: [],
			attributes: [member("startup", "ReadValue", "WriteValue")]}], ...runtimeOverrides};
	const protos = {application: "factorio", application_version: "2.1.20", api_version: 6, stage: "prototype", types, prototypes: []};
	await writeFile(path.join(dir, "runtime.json"), JSON.stringify(runtime));
	await writeFile(path.join(dir, "prototype.json"), JSON.stringify(protos));
	return {dir, args: ["--docs", path.join(dir, "runtime.json"), "--protos", path.join(dir, "prototype.json")]};
}

async function files(dir:string, prefix = ""):Promise<Record<string, string>> {
	const result:Record<string, string> = {};
	for (const entry of await readdir(path.join(dir, prefix), {withFileTypes: true})) {
		const name = path.join(prefix, entry.name);
		if (entry.isDirectory()) { Object.assign(result, await files(dir, name)); } else { result[name] = await readFile(path.join(dir, name), "utf8"); }
	}
	return result;
}

await test("docs preserves asymmetric attributes only for the EmmyLua target", async ()=>{
	const {dir, args} = await fixture();
	for (const target of ["default", "luals", "emmylua"]) {
		await forkTest(cli, ["docs", path.join(dir, target), ...args, ...(target === "default" ? [] : ["--target", target])]);
	}
	assert.deepEqual(await files(path.join(dir, "default")), await files(path.join(dir, "luals")));
	const legacy = await readFile(path.join(dir, "default/factorio/library/runtime-api/Sample.lua"), "utf8");
	assert.match(legacy, /---@field value\? WriteValue/);
	assert.doesNotMatch(legacy, /---@field \((read|write)\)/);
	const output = await readFile(path.join(dir, "emmylua/factorio/library/runtime-api/Sample.lua"), "utf8");
	assert.match(output, /---@field \(read\) value\? ReadValue/);
	assert.match(output, /---@field \(write\) value\? WriteValue/);
	assert.match(output, /---@field equal string/);
	assert.match(output, /---@field readonly string/);
	assert.match(output, /---@field writeonly number/);
	assert.match(output, /---@field \(read\) field number/);
	assert.match(output, /---@field \(write\) field string/);
	assert.match(output, /---@class \(exact\) Sample.converted.read/);
	assert.match(output, /---@class \(exact\) Sample.converted.write/);
	const overlay = await readFile(path.join(dir, "emmylua/factorio/library/runtime-api/LuaSettings.lua"), "utf8");
	assert.match(overlay, /---@field startup StartupModSettings/);
	assert.doesNotMatch(overlay, /---@field \((read|write)\)/);
});

await test("docs rejects an unknown target", async ()=>{
	const result = await forkTestFails(cli, ["docs", "--target", "unknown"]);
	assert.notEqual(result.code, 0);
});

await test("remote.call preserves its return sequence for EmmyLua", async ()=>{
	const {dir, args} = await fixture();
	const runtimePath = path.join(dir, "runtime.json");
	const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
	runtime.classes.push({name: "LuaRemote", order: 2, description: "Remote", abstract: false,
		attributes: [], operators: [], methods: [{name: "call", order: 0, description: "Call an interface.",
			parameters: [], return_values: [], format: {takes_table: false}}]});
	await writeFile(runtimePath, JSON.stringify(runtime));
	for (const target of ["default", "luals", "emmylua"]) {
		await forkTest(cli, ["docs", path.join(dir, target), ...args, ...(target === "default" ? [] : ["--target", target])]);
		const output = await readFile(path.join(dir, target, "factorio/library/runtime-api/LuaRemote.lua"), "utf8");
		if (target === "emmylua") {
			assert.match(output, /---@return ReturnType<FF>\s*\r?\n/);
			assert.doesNotMatch(output, /---@return ReturnType<FF>\.\.\./);
		} else {
			assert.match(output, /---@return ReturnType<FF>\.\.\./);
		}
		// Argument packs and the genuine unknown-interface variadic fallback stay intact.
		assert.match(output, /---@param \.\.\. Parameters<FF>\.\.\./);
		assert.match(output, /or \(fun\(\.\.\.:Any\?\):Any\?\.\.\.\)/);
	}
});

await test("runtime position outputs have named coordinates while inputs accept tuples", async ()=>{
	const doc = (name:string)=>({name, order: 0, description: ""});
	const param = (name:string, type:ApiType):ApiParameter=>({...doc(name), type, optional: false});
	const coordinates = [param("x", "double"), param("y", "double")];
	const tuple = {complex_type: "tuple", values: ["double", "double"]} satisfies ApiTupleType;
	const coordinatesType = {complex_type: "table", parameters: coordinates} satisfies ApiTableType;
	const waypoint = {...doc("Waypoint"), type: {complex_type: "table", parameters: [param("position", "MapPosition")]}} satisfies ApiConcept;
	const settings:ApiConcept = {...doc("MapGenSettings"), type: {complex_type: "table", parameters: [
		param("starting_points", {complex_type: "array", value: "MapPosition"}),
	]}};
	const findPosition:ApiMethod = {
		...doc("find_position"), format: {takes_table: false},
		parameters: [param("start", "MapPosition")],
		return_values: [{order: 0, description: "", type: "MapPosition", optional: true}],
	};
	const {dir, args} = await fixture({
		concepts: [{...doc("MapPosition"), type: {complex_type: "union", options: [coordinatesType, tuple]}}, waypoint, settings],
		classes: [
			{...doc("LuaControl"), abstract: true, methods: [], operators: [], attributes: [member("position", "MapPosition")]},
			{...doc("LuaEntity"), abstract: false, operators: [], methods: [findPosition], attributes: [
				member("drop_position", "MapPosition", "MapPosition"),
				member("waypoints", {complex_type: "array", value: "Waypoint"}),
			]},
			{...doc("LuaSurface"), abstract: false, operators: [], methods: [],
				attributes: [member("map_gen_settings", "MapGenSettings", "MapGenSettings")]},
		],
		events: [{...doc("on_position"), data: [param("target_position", "MapPosition")]}],
	}, [{...doc("MapPosition"), abstract: false, inline: false,
		type: {complex_type: "union", options: [{complex_type: "struct"}, tuple]},
		properties: coordinates.map(({name})=>({...doc(name), type: "double", optional: false, override: false, default: ""}))}]);

	for (const target of ["luals", "emmylua"]) {
		await forkTest(cli, ["docs", path.join(dir, target), ...args, "--target", target]);
	}
	const library = (target:string, file:string)=>readFile(path.join(dir, target, "factorio/library", file), "utf8");
	assert.match(await library("emmylua", "runtime-api/LuaControl.lua"), /^---@field position MapPosition\.struct$/m);
	assert.match(await library("luals", "runtime-api/LuaControl.lua"), /^---@field position MapPosition$/m);
	const entity = await library("emmylua", "runtime-api/LuaEntity.lua");
	assert.match(entity, /^---@field \(read\) drop_position MapPosition\.struct$/m);
	assert.match(entity, /^---@field \(write\) drop_position MapPosition$/m);
	assert.match(entity, /^---@param start MapPosition /m);
	assert.match(entity, /^---@return MapPosition\.struct\? /m);
	assert.match(entity, /^---@field waypoints \(Waypoint\.read\)\[\]$/m);
	assert.match(await library("emmylua", "runtime-api/events.lua"), /^---@field target_position MapPosition\.struct$/m);

	const concepts = await library("emmylua", "runtime-api/concepts.lua");
	const inputPosition = /^---@alias MapPosition \(MapPosition\.struct\)\|\(\[double, double\]\)$/m;
	assert.match(concepts, inputPosition);
	const classes = concepts.split(/^---@class \(exact\) /m);
	const declaration = (name:string)=>classes.find(block=>block.startsWith(name + "\n")) ?? "";
	assert.match(declaration("Waypoint"), /^---@field position MapPosition$/m);
	assert.match(declaration("Waypoint.read:Waypoint"), /^---@field position MapPosition\.struct$/m);
	const surface = await library("emmylua", "runtime-api/LuaSurface.lua");
	assert.match(surface, /^---@field map_gen_settings MapGenSettings$/m);
	assert.match(declaration("MapGenSettings"), /^---@field starting_points \(MapPosition\)\[\]$/m);

	const legacy = await library("luals", "runtime-api/LuaEntity.lua");
	assert.match(legacy, /^---@field drop_position MapPosition$/m);
	assert.match(legacy, /^---@return MapPosition\? /m);
	assert.match(legacy, /^---@field waypoints \(Waypoint\)\[\]$/m);
	const protoPosition = "prototype-api/concepts/MapPosition.lua";
	const prototype = await library("emmylua", protoPosition);
	assert.equal(prototype, await library("luals", protoPosition));
	assert.match(prototype, inputPosition);
});

await test("GUI styles, research queues and tile filters use their documented property contracts", async ()=>{
	const {dir, args} = await fixture();
	const runtimePath = path.join(dir, "runtime.json");
	const runtime:ApiDocs = JSON.parse(await readFile(runtimePath, "utf8"));
	const style:ApiType = {complex_type: "union", options: ["LuaStyle", "string"]};
	const queue:ApiType = {complex_type: "array", value: "TechnologyID"};
	const tiles:ApiType = {complex_type: "array", value: "TileID"};
	const attributes = {
		LuaGuiElement: member("style", style, style),
		LuaForce: member("research_queue", queue, queue),
		LuaItemCommon: member("tile_filters", tiles, tiles),
		LuaRecord: member("tile_filters", tiles, tiles),
	};
	for (const [name, attribute] of Object.entries(attributes)) {
		runtime.classes.push({name, order: 0, description: "", abstract: false,
			attributes: [attribute], methods: [], operators: []});
	}
	await writeFile(runtimePath, JSON.stringify(runtime));
	await forkTest(cli, ["docs", dir, ...args, "--target", "emmylua"]);
	const readClass = (name:string)=>readFile(path.join(dir, "factorio/library/runtime-api", name + ".lua"), "utf8");
	const gui = await readClass("LuaGuiElement");
	assert.match(gui, /^---@field \(read\) style LuaStyle$/m);
	assert.match(gui, /^---@field \(write\) style string$/m);
	const force = await readClass("LuaForce");
	assert.match(force, /^---@field \(read\) research_queue \(LuaTechnology\)\[\]$/m);
	assert.match(force, /^---@field \(write\) research_queue \(\(TechnologyID\)\[\]\)\|\(nil\)$/m);
	for (const name of ["LuaItemCommon", "LuaRecord"]) {
		const item = await readClass(name);
		assert.match(item, /^---@field \(read\) tile_filters \(string\)\[\]$/m);
		assert.match(item, /^---@field \(write\) tile_filters \(TileID\)\[\]$/m);
	}
});
