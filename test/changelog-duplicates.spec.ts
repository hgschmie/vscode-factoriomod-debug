import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ChangeLogLanguageService } from "../src/Language/ChangeLog.ts";

const separator = "-".repeat(99);
const header = `${separator}\nVersion: 1.0.0\nDate: 2026-10-21\n  Bugfixes:\n`;

function duplicates(body:string, newline = "\n") {
	const service = new ChangeLogLanguageService();
	const uri = "file:///mod/changelog.txt";
	service.loadDocument(TextDocument.create(uri, "factorio-changelog", 1, (header + body).replaceAll("\n", newline)));
	return service.diagnose(uri).filter(diagnostic=>diagnostic.code === "entry.duplicate");
}

await test("the game rejects repeated continuation credits across entries", ()=>{
	assert.equal(duplicates("    - Fix translated messages.\n      Reported by Alice.\n    - Fix refueling.\n      Reported by Alice.\n").length, 1);
});

await test("different continuations do not exempt identical first lines", ()=>{
	assert.equal(duplicates("    - Fix a problem.\n      In the depot.\n    - Fix a problem.\n      At the provider.\n").length, 1);
});

await test("repeated continuation lines within an entry are duplicates", ()=>{
	assert.equal(duplicates("    - Explain a sequence.\n      Wait.\n      Change the signal.\n      Wait.\n").length, 1);
});

await test("identical multiline entries report each repeated physical line", ()=>{
	const result = duplicates("    - Fix a problem.\n      Reported by Alice.\n    - Fix a problem.\n      Reported by Alice.\n");
	assert.equal(result.length, 2);
	assert.equal(result[0].range.start.line, 6);
	assert.equal(result[0].relatedInformation?.[0].location.range.start.line, 4);
});

await test("identical single-line entries still report duplicates", ()=>{
	assert.equal(duplicates("    - Fix a problem.\n    - Fix a problem.\n").length, 1);
});

await test("nested bullets share the category duplicate scope", ()=>{
	assert.equal(duplicates("    - Depot changes:\n      - Fix refueling.\n    - Provider changes:\n      - Fix refueling.\n").length, 1);
	assert.equal(duplicates("    - Depot changes:\n      - Fix refueling.\n      - Fix refueling.\n").length, 1);
});

await test("nested content does not exempt identical parent lines", ()=>{
	assert.equal(duplicates("    - Fixes:\n      - Depot routing.\n    - Fixes:\n      - Provider routing.\n").length, 1);
	const result = duplicates("    - Fixes:\n      - Depot routing.\n    - Fixes:\n      - Depot routing.\n");
	assert.equal(result.length, 2);
	assert.equal(result[0].range.start.line, 6);
});

await test("categories and versions have separate duplicate scopes", ()=>{
	assert.deepEqual(duplicates(`    - Shared text.\n  Changes:\n    - Shared text.\n${separator}\nVersion: 0.9.0\nDate: 2026-10-20\n  Bugfixes:\n    - Shared text.\n`), []);
});

await test("reopened categories within one version retain duplicate detection", ()=>{
	assert.equal(duplicates("    - Fix a problem.\n  Changes:\n    - Add a feature.\n  Bugfixes:\n    - Fix a problem.\n").length, 1);
});

await test("blank lines and line endings do not exempt repeated continuation links", ()=>{
	for (const newline of ["\n", "\r\n"]) {
		const result = duplicates("    - First change.\n      (https://example.com/a)\n\n    - Second change.\n      (https://example.com/b)\n\n    - Third change.\n      (https://example.com/a)\n", newline);
		assert.equal(result.length, 1);
		assert.equal(result[0].range.start.line, 11);
		assert.equal(result[0].relatedInformation?.[0].location.range.start.line, 5);
	}
});
