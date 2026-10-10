import { describe, expect, it } from "bun:test";
import { ParkedBustTriggers } from "./trigger-parking";

describe("parked bust triggers", () => {
    it("releases all parked triggers together only without a boundary", () => {
        const triggers = new ParkedBustTriggers();
        expect(triggers.permissions(true, true, true)).toEqual({
            materialization: true,
            force: true,
        });
        triggers.holdMaterialization();
        triggers.holdForce();
        expect(triggers.permissions(true, true, true)).toEqual({
            materialization: false,
            force: false,
        });
        expect(triggers.permissions(false, true, true)).toEqual({
            materialization: true,
            force: true,
        });
        triggers.settle(false, false);
        expect(triggers.pending).toBe(false);
    });

    it("cancels inactive obligations without granting a permission", () => {
        const triggers = new ParkedBustTriggers();
        triggers.holdMaterialization();
        triggers.holdForce();
        expect(triggers.permissions(true, false, false)).toEqual({
            materialization: false,
            force: false,
        });
        expect(triggers.pending).toBe(false);
        expect(triggers.permissions(false, false, false)).toEqual({
            materialization: false,
            force: false,
        });
    });

    it("settles each obligation independently", () => {
        const triggers = new ParkedBustTriggers();
        triggers.holdMaterialization();
        triggers.holdForce();
        triggers.settle(true, false);
        expect(triggers.permissions(true, true, true)).toEqual({
            materialization: false,
            force: true,
        });
        triggers.settle(false, true);
        expect(triggers.pending).toBe(false);
    });
});
