// The game returns MapPosition with named coordinates but also accepts positional tuples.
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

export class RuntimeReadTypes {
	private readonly names = new Map([["MapPosition", "MapPosition.struct"]]);
	readonly usedConcepts = new Set<string>();

	constructor(docs: ApiDocs) {
		const inputs = inputConcepts(docs);
		// Find concepts that transitively contain a position, including recursive records.
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

	resolve(type:ApiType):ApiType {
		return mapReadType(type, name=>{
			const read = this.names.get(name);
			if (!read) { return name; }
			if (name !== "MapPosition") { this.usedConcepts.add(name); }
			return read;
		});
	}
}
