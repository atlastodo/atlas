/**
 * The test app every client-core test runs with: the `definition` of
 * test-vectors/scope_rule_vectors.json, a todo-shaped app. Core itself has no app's scope rules.
 */
import vectors from "../../../test-vectors/scope_rule_vectors.json";
import { registerApp, type AppDefinition } from "./fieldPolicy";

export const TEST_APP = vectors.definition as unknown as AppDefinition;

registerApp(TEST_APP);
