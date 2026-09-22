import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { resolveVariable } from "../shared/scope.ts";

const moduleMockMethods = new Set(["doMock", "mock", "setMock", "unstable_mockModule"]);

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function isNamedImport(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  moduleName: string,
  exportName: string,
): boolean {
  if (expression.type !== "Identifier") return false;

  const variable = resolveVariable(sourceCode, expression);
  return (
    variable?.defs.some(
      (definition) =>
        definition.type === "ImportBinding" &&
        definition.parent?.type === "ImportDeclaration" &&
        definition.parent.source.value === moduleName &&
        importedName(definition.node) === exportName,
    ) ?? false
  );
}

function isNamespaceImport(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  moduleName: string,
): boolean {
  if (expression.type !== "Identifier") return false;

  const variable = resolveVariable(sourceCode, expression);
  return (
    variable?.defs.some(
      (definition) =>
        definition.type === "ImportBinding" &&
        definition.node.type === "ImportNamespaceSpecifier" &&
        definition.parent?.type === "ImportDeclaration" &&
        definition.parent.source.value === moduleName,
    ) ?? false
  );
}

function isVitestOrJestObject(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === "MemberExpression") {
    const ownerName = staticMemberName(unwrapped);
    return (
      (ownerName === "vi" && isNamespaceImport(sourceCode, unwrapped.object, "vitest")) ||
      (ownerName === "jest" &&
        isNamespaceImport(sourceCode, unwrapped.object, "@jest/globals"))
    );
  }
  if (unwrapped.type !== "Identifier") return false;
  if (
    (unwrapped.name === "vi" || unwrapped.name === "jest") &&
    sourceCode.isGlobalReference(unwrapped)
  ) {
    return true;
  }

  const variable = resolveVariable(sourceCode, unwrapped);
  if (variable === null || variable.defs.length === 0) {
    return unwrapped.name === "vi" || unwrapped.name === "jest";
  }
  return (
    isNamedImport(sourceCode, unwrapped, "vitest", "vi") ||
    isNamedImport(sourceCode, unwrapped, "@jest/globals", "jest")
  );
}

function staticMemberName(member: ESTree.MemberExpression): string | null {
  const property = member.property;
  if (member.computed) {
    return property.type === "Literal" && typeof property.value === "string"
      ? property.value
      : null;
  }
  return property.type === "Identifier" ? property.name : null;
}

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function stableConstDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator") {
    return null;
  }
  const declaration = definition.node.parent;
  if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const") return null;
  return variable.references.every((reference) => reference.init || !reference.isWrite())
    ? definition.node
    : null;
}

function isBunMockOwner(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  visitedVariables = new Set<Variable>(),
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (isNamedImport(sourceCode, unwrapped, "bun:test", "mock")) return true;

  if (unwrapped.type === "MemberExpression") {
    return (
      staticMemberName(unwrapped) === "mock" &&
      isNamespaceImport(sourceCode, unwrapped.object, "bun:test")
    );
  }

  if (unwrapped.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, unwrapped);
  if (variable === null || visitedVariables.has(variable)) return false;
  const declarator = stableConstDeclarator(variable);
  if (declarator === null || declarator.id.type !== "Identifier" || declarator.init === null) {
    return false;
  }
  visitedVariables.add(variable);
  return isBunMockOwner(sourceCode, declarator.init, visitedVariables);
}

function bindingIdentifierName(pattern: ESTree.BindingPattern): string | null {
  if (pattern.type === "Identifier") return pattern.name;
  return pattern.type === "AssignmentPattern" && pattern.left.type === "Identifier"
    ? pattern.left.name
    : null;
}

function bindingPropertyName(property: ESTree.BindingProperty): string | null {
  if (property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" && typeof property.key.value === "string"
    ? property.key.value
    : null;
}

function isBunModuleMember(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    unwrapped.type === "MemberExpression" &&
    staticMemberName(unwrapped) === "module" &&
    isBunMockOwner(sourceCode, unwrapped.object)
  );
}

function isBunModuleBinding(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
  const variable = resolveVariable(sourceCode, identifier);
  if (variable === null) return false;
  const declarator = stableConstDeclarator(variable);
  if (declarator === null || declarator.init === null) return false;

  if (declarator.id.type === "Identifier") {
    return isBunModuleMember(sourceCode, declarator.init);
  }

  if (declarator.id.type !== "ObjectPattern" || !isBunMockOwner(sourceCode, declarator.init)) {
    return false;
  }

  return declarator.id.properties.some(
    (property) =>
      property.type === "Property" &&
      bindingPropertyName(property) === "module" &&
      bindingIdentifierName(property.value) === identifier.name,
  );
}

function moduleMockCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  if (callee.type === "Identifier") return isBunModuleBinding(sourceCode, callee);
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return false;
  const method = staticMemberName(callee);
  return (
    (method !== null &&
      moduleMockMethods.has(method) &&
      isVitestOrJestObject(sourceCode, callee.object)) ||
    (method === "module" && isBunMockOwner(sourceCode, callee.object))
  );
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Bun, Vitest, and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
