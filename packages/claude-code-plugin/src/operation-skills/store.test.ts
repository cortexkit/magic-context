import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
    driftOf,
    findOperations,
    isStale,
    listSkills,
    loadSkill,
    markVerified,
    type OperationInput,
    OperationSkillError,
    removeSkillOrOperation,
    saveSkill,
    searchTokens,
} from "./store";

function project(): string {
    const { dir } = createTestTempDir("mc-claude-code-opskills-");
    mkdirSync(join(dir, "web/src/pages"), { recursive: true });
    mkdirSync(join(dir, "server/routes"), { recursive: true });
    writeFileSync(join(dir, "web/src/pages/OrderEdit.tsx"), "export function OrderEdit() {}\n");
    writeFileSync(join(dir, "web/src/api.ts"), "export const api = {};\n");
    writeFileSync(join(dir, "server/routes/orders.ts"), "export function updateOrder() {}\n");
    return dir;
}

function saveOrder(overrides: Partial<OperationInput> = {}): OperationInput {
    return {
        id: "save-order",
        trigger: {
            kind: "button",
            label: "保存",
            location: "web/src/pages/OrderEdit.tsx:120",
            event: "onClick",
        },
        intents: ["保存订单", "save the order"],
        action: { summary: "Validates the form and saves the order", handler: "handleSave" },
        apis: [
            {
                method: "put",
                endpoint: "/api/orders/:id",
                request: "{ status, items }",
                handler: "server/routes/orders.ts:updateOrder",
            },
        ],
        writes: [{ target: "orders", fields: "status, total, updated_at" }],
        state: [{ target: "orderStore.orders", change: "replace the order by id" }],
        saveAndLinkage: "toast, then the order list refetches",
        filesToModify: ["web/src/pages/OrderEdit.tsx", "web/src/api.ts", "../outside.ts"],
        steps: ["curl -X PUT localhost:3000/api/orders/<id> -d '{...}'", "check the orders row"],
        verification: { method: "curl + sqlite query", evidence: "row 42 updated" },
        ...overrides,
    };
}

describe("operation skill store", () => {
    test("saves a skill as flow.json plus a native SKILL.md", () => {
        const dir = project();
        const { skill, created } = saveSkill(
            dir,
            {
                name: "order-editor",
                title: "订单编辑页",
                description: "Saving and deleting orders on the order edit page.",
                scope: "./web/",
                setup: ["pnpm dev  # serves http://localhost:3000", " "],
                operations: [saveOrder()],
            },
            "2026-10-04T00:00:00.000Z",
        );
        expect(created).toBe(true);
        expect(skill.scope).toBe("web");
        expect(skill.setup).toEqual(["pnpm dev  # serves http://localhost:3000"]);
        const markdown = readFileSync(join(dir, ".claude/skills/order-editor/SKILL.md"), "utf8");
        expect(markdown).toStartWith("---\nname: order-editor\ndescription: ");
        expect(markdown).toContain("Operations: 保存. Verified flows:");
        expect(markdown).toContain("## 准备 Setup");
        expect(markdown).toContain("1. pnpm dev  # serves http://localhost:3000");
        expect(markdown).toContain("`PUT /api/orders/:id`");
        expect(markdown).toContain("orders: status, total, updated_at");
        expect(markdown).toContain("已验证 Verified:** 2026-10-04 by curl + sqlite query");
        const flow = JSON.parse(
            readFileSync(join(dir, ".claude/skills/order-editor/flow.json"), "utf8"),
        );
        expect(flow.schema).toBe("magic-context/operation-skill@1");
        expect(flow.operations[0].verification.verifiedAt).toBe("2026-10-04T00:00:00.000Z");
    });

    test("tracks only the project files an operation references", () => {
        const dir = project();
        const { skill } = saveSkill(dir, {
            name: "order-editor",
            title: "订单编辑页",
            description: "Orders.",
            operations: [saveOrder()],
        });
        expect(Object.keys(skill.operations[0].fileHashes)).toEqual([
            "server/routes/orders.ts",
            "web/src/api.ts",
            "web/src/pages/OrderEdit.tsx",
        ]);
    });

    test("reports the files that changed or vanished since verification", () => {
        const dir = project();
        saveSkill(dir, {
            name: "order-editor",
            title: "订单编辑页",
            description: "Orders.",
            operations: [saveOrder()],
        });
        const fresh = loadSkill(dir, "order-editor")?.operations[0];
        if (!fresh) throw new Error("missing operation");
        expect(isStale(driftOf(dir, fresh))).toBe(false);

        writeFileSync(join(dir, "web/src/api.ts"), "export const api = { changed: true };\n");
        rmSync(join(dir, "server/routes/orders.ts"));
        expect(driftOf(dir, fresh)).toEqual({
            changed: ["web/src/api.ts"],
            missing: ["server/routes/orders.ts"],
        });

        writeFileSync(join(dir, "server/routes/orders.ts"), "moved back\n");
        markVerified(dir, "order-editor", "save-order", { method: "re-ran the curl check" });
        const reverified = loadSkill(dir, "order-editor")?.operations[0];
        if (!reverified) throw new Error("missing operation");
        expect(isStale(driftOf(dir, reverified))).toBe(false);
        expect(reverified.verification.method).toBe("re-ran the curl check");
    });

    test("updates operations by id and keeps the others", () => {
        const dir = project();
        saveSkill(dir, {
            name: "order-editor",
            title: "订单编辑页",
            description: "Orders.",
            operations: [
                saveOrder(),
                saveOrder({ id: "delete-order", trigger: { kind: "button", label: "删除" } }),
            ],
        });
        const { skill, created } = saveSkill(dir, {
            name: "order-editor",
            operations: [saveOrder({ writes: [{ target: "orders" }, { target: "order_audit" }] })],
        });
        expect(created).toBe(false);
        expect(skill.title).toBe("订单编辑页");
        expect(skill.setup).toBeUndefined();
        saveSkill(dir, { name: "order-editor", setup: ["make run"] });
        expect(saveSkill(dir, { name: "order-editor" }).skill.setup).toEqual(["make run"]);
        expect(skill.operations.map((operation) => operation.id)).toEqual([
            "save-order",
            "delete-order",
        ]);
        expect(skill.operations[0].writes.map((write) => write.target)).toEqual([
            "orders",
            "order_audit",
        ]);
    });

    test("finds the operation for a request in Chinese or English", () => {
        const dir = project();
        saveSkill(dir, {
            name: "order-editor",
            title: "订单编辑页",
            description: "Orders.",
            operations: [
                saveOrder(),
                saveOrder({
                    id: "delete-order",
                    trigger: { kind: "button", label: "删除" },
                    intents: ["删除订单", "delete the order"],
                    apis: [{ method: "DELETE", endpoint: "/api/orders/:id" }],
                }),
            ],
        });
        const save = findOperations(dir, "帮我点一下保存按钮")[0];
        expect(save?.operation.id).toBe("save-order");
        expect(save?.strong).toBe(true);
        expect(findOperations(dir, "the order editor page")[0]?.strong).toBe(false);
        expect(findOperations(dir, "把这个订单删除掉")[0]?.operation.id).toBe("delete-order");
        expect(findOperations(dir, "please delete the order 42")[0]?.operation.id).toBe(
            "delete-order",
        );
        expect(findOperations(dir, "weather tomorrow")).toEqual([]);
    });

    test("tokenizes CJK text into pairs and Latin text into words", () => {
        expect([...searchTokens("点保存")]).toEqual(["点保", "保存"]);
        expect([...searchTokens("Save the Order!")]).toEqual(["save", "the", "order"]);
    });

    test("removes an operation, and the skill with its last operation", () => {
        const dir = project();
        saveSkill(dir, {
            name: "order-editor",
            title: "订单编辑页",
            description: "Orders.",
            operations: [saveOrder(), saveOrder({ id: "delete-order" })],
        });
        expect(removeSkillOrOperation(dir, "order-editor", "delete-order")).toBe("operation");
        expect(loadSkill(dir, "order-editor")?.operations).toHaveLength(1);
        expect(removeSkillOrOperation(dir, "order-editor", "save-order")).toBe("skill");
        expect(listSkills(dir)).toEqual([]);
    });

    test("refuses invalid input and skills it does not manage", () => {
        const dir = project();
        const attempt = (input: Parameters<typeof saveSkill>[1]) => () => saveSkill(dir, input);
        expect(
            attempt({ name: "Bad Name", title: "t", description: "d", operations: [saveOrder()] }),
        ).toThrow(OperationSkillError);
        expect(attempt({ name: "orders", operations: [saveOrder()] })).toThrow(
            "title and a description",
        );
        expect(
            attempt({
                name: "orders",
                title: "t",
                description: "d",
                operations: [saveOrder({ verification: { method: " " } })],
            }),
        ).toThrow("how it was verified");
        expect(
            attempt({
                name: "orders",
                title: "t",
                description: "d",
                operations: [saveOrder({ steps: [] })],
            }),
        ).toThrow("at least one step");

        mkdirSync(join(dir, ".claude/skills/handmade"), { recursive: true });
        writeFileSync(join(dir, ".claude/skills/handmade/SKILL.md"), "---\nname: handmade\n---\n");
        expect(
            attempt({ name: "handmade", title: "t", description: "d", operations: [saveOrder()] }),
        ).toThrow("not a Magic Context operation skill");
        expect(listSkills(dir)).toEqual([]);
    });
});
