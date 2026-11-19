// Replace type references only. Literal values, parameter names and input types stay intact.
function mapReadType(type:ApiType, name:(name:string)=>string):ApiType {
	if (typeof type === "string") { return name(type); }
	const map = (child:ApiType)=>mapReadType(child, name);
	switch (type.complex_type) {
		case "array":
		case "type":
		case "LuaLazyLoadedValue":
			return {...type, value: map(type.value)};
		case "dictionary":
		case "LuaCustomTable":
			return {...type, key: map(type.key), value: map(type.value)};
		case "union":
			return {...type, options: type.options.map(map)};
		case "tuple":
			return {...type, values: type.values.map(map)};
		case "table": {
			const parameter = (param:ApiParameter)=>({...param, type: map(param.type)});
			return {...type, parameters: type.parameters.map(parameter),
				variant_parameter_groups: type.variant_parameter_groups?.map(group=>({
					...group, parameters: group.parameters.map(parameter),
				}))};
		}
		case "LuaStruct": // Each member declares its own read and write types.
		case "function": // Parameters of a returned function are inputs from the caller.
		case "literal":
			return type;
	}
}

// A record accepted back by the engine can be edited as a plain Lua table first.
// Its fields must continue to accept tuples, which stay tuples until passed to the engine.
function inputConcepts(docs:ApiDocs) {
	const inputs = new Set<string>();
	const add = (type:ApiType|undefined)=>{
		if (type) {
			mapReadType(type, name=>{ inputs.add(name); return name; });
		}
	};
	const addMethod = (method:ApiMethod)=>{
		for (const param of method.parameters) { add(param.type); }
		for (const group of method.variant_parameter_groups ?? []) {
			for (const param of group.parameters) { add(param.type); }
		}
		add(method.variadic_parameter?.type);
	};

	for (const method of docs.global_functions) { addMethod(method); }
	for (const cls of docs.classes) {
		for (const member of cls.attributes) { add(member.write_type); }
		for (const method of cls.methods) { addMethod(method); }
		for (const operator of cls.operators) {
			if (operator.name === "call") {
				addMethod(operator);
			} else {
				add(operator.write_type);
			}
		}
	}
	const concepts = new Map(docs.concepts.map(c=>[c.name, c.type]));
	for (const concept of docs.concepts) {
		if (typeof concept.type === "object" && concept.type.complex_type === "LuaStruct") {
			for (const member of concept.type.attributes) { add(member.write_type); }
		}
	}
	for (const name of inputs) {
		const type = concepts.get(name);
		if (type && !(typeof type === "object" && type.complex_type === "builtin")) { add(type); }
	}
	return inputs;
}

function isColor(name:string) {
	return name === "Color" || name === "ColorModifier";
}

export class RuntimeReadTypes {
	// A returned bounding box has named corners, but Lua code can replace a corner with a tuple.
	private readonly names = new Map([
		["MapPosition", "MapPosition.struct"], ["TilePosition", "TilePosition.struct"],
		["ChunkPosition", "ChunkPosition.struct"], ["EquipmentPosition", "EquipmentPosition.struct"],
		["GuiLocation", "GuiLocation.struct"], ["Vector3D", "Vector3D.struct"],
		["Vector", "Vector.read"], ["BoundingBox", "BoundingBox.struct"],
		["Color", "Color.read"], ["ColorModifier", "ColorModifier.read"],
		["ScriptRenderTarget", "ScriptRenderTargetTable"],
	]);
	readonly usedConcepts = new Set<string>();

	constructor(docs: ApiDocs) {
		const inputs = inputConcepts(docs);
		// Find output-only concepts that transitively contain any normalized type.
		const dependents = new Map<string, string[]>();
		for (const concept of docs.concepts) {
			if (typeof concept.type === "object" && concept.type.complex_type === "builtin") { continue; }
			mapReadType(concept.type, name=>{
				const users = dependents.get(name);
				if (users) {
					users.push(concept.name);
				} else {
					dependents.set(name, [concept.name]);
				}
				return name;
			});
		}
		for (const name of this.names.keys()) {
			for (const user of dependents.get(name) ?? []) {
				if (!inputs.has(user) && !this.names.has(user)) { this.names.set(user, `${user}.read`); }
			}
		}
	}

	// Both RGB and RGBA are accepted. The runtime schema only spells out the longer tuple.
	inputConcept({name, type}:ApiConcept):ApiConcept["type"] {
		if (!isColor(name) || typeof type !== "object" || type.complex_type !== "union") { return type; }
		const tuples = type.options.filter((t):t is ApiTupleType=>typeof t === "object" && t.complex_type === "tuple");
		const rgba = tuples.find(t=>t.values.length === 4);
		if (!rgba || tuples.some(t=>t.values.length === 3)) { return type; }
		return {...type, options: [...type.options, {...rgba, values: rgba.values.slice(0, 3)}]};
	}

	// Keep normalized records assignable to the corresponding public input shape.
	readConcept({name, type}:ApiConcept) {
		if (typeof type === "object") {
			if (type.complex_type === "builtin") { return; }
			if (type.complex_type === "union") {
				const [struct, tuple] = type.options;
				if (name === "Vector" && typeof tuple === "object" && tuple.complex_type === "tuple") {
					return {type: tuple, source: name};
				}
				if (isColor(name) && typeof struct === "object" && struct.complex_type === "table") {
					return {type: {...struct, parameters: struct.parameters.map(p=>({...p, optional: false}))}, source: `${name}.struct`};
				}
			}
		}
		return {type: this.resolve(type), source: name};
	}

	resolve(type:ApiType):ApiType {
		return mapReadType(type, name=>{
			const read = this.names.get(name);
			if (!read) { return name; }
			if (read === `${name}.read`) { this.usedConcepts.add(name); }
			return read;
		});
	}
}
