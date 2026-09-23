/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * Read-only traversal plans for GraphQL query complexity analysis.
 *
 * A query document is static: its operations, fragment edges, field
 * coordinates, @include/@skip expressions and the possible types of
 * abstract types can all be resolved before request variables are known.
 * `compileComplexityPlan` performs that work once (against a specific
 * schema instance and estimator configuration) and produces an immutable
 * {@link ComplexityPlan}. The plan is evaluated per request with the
 * coerced operation variables, reusing the exact estimator ordering and
 * short-circuit semantics of the direct {@link getComplexity} path.
 *
 * A plan is only reusable when it is evaluated against the same schema
 * instance and rule configuration it was compiled with. A matching query
 * text / hash is NOT considered proof of schema compatibility.
 */

import {
  getArgumentValues,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  GraphQLField,
  isCompositeType,
  GraphQLCompositeType,
  GraphQLFieldMap,
  GraphQLSchema,
  DocumentNode,
  GraphQLDirective,
  isAbstractType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  getNamedType,
  GraphQLError,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
} from 'graphql';

import {
  ComplexityEstimator,
  ComplexityMap,
  addComplexities,
  getExecutionVariableValues,
  getOperationVariableValues,
  queryComplexityMessage,
  resolveFieldComplexity,
  shouldIncludeNode,
} from './QueryComplexity.js';

export interface CompileComplexityPlanOptions {
  // The estimators the plan is compiled for. Plan reuse requires passing
  // the exact same estimator functions (same order, same identity).
  estimators: ComplexityEstimator[];

  // Operation name when the plan is compiled for a specific operation of a
  // multi-operation document. When omitted, the plan covers every operation
  // and the operation can be selected per estimate.
  operationName?: string;

  // The maximum number of nodes evaluated per estimate. Compiled into the
  // plan so a different limit rejects reuse. Defaults to 10_000.
  maxQueryNodes?: number;

  // Compile-phase callback. Invoked once per issue that can be detected
  // without request variables, such as unknown fragments or explicit
  // fragment cycles. These never become estimate-phase errors: unknown
  // fragments and cycle back edges are skipped during evaluation, matching
  // the direct path.
  onCompileError?: (error: GraphQLError) => void;
}

export interface EstimateComplexityOptions {
  // The request variables, merged with the operation's default values
  // during evaluation.
  variables?: Record<string, any>;

  // Selects a single operation of a multi-operation document.
  operationName?: string;

  // Passed through to estimators via the estimator context.
  context?: Record<string, any>;

  // When the calculated complexity exceeds this value, an error is raised.
  // Defaults to Infinity (only return the complexity).
  maximumComplexity?: number;

  // Optional function to create the "maximum complexity exceeded" error.
  createError?: (max: number, actual: number) => GraphQLError;

  // Invoked after every evaluated operation with the accumulated complexity.
  onComplete?: (complexity: number) => void;

  // Compatibility guards. When provided, they must be identical to the
  // configuration the plan was compiled with, otherwise estimation rejects
  // reuse with an Error.
  schema?: GraphQLSchema;
  estimators?: ComplexityEstimator[];
  maxQueryNodes?: number;
}

export interface ComplexityPlanCompatibility {
  schema?: GraphQLSchema;
  estimators?: ComplexityEstimator[];
  operationName?: string;
  maxQueryNodes?: number;
}

export interface ComplexityPlan {
  // The schema instance the plan was compiled against.
  readonly schema: GraphQLSchema;
  // The document the plan was compiled from. The plan only holds references
  // into this immutable AST, it never mutates it.
  readonly document: DocumentNode;
  readonly estimators: ReadonlyArray<ComplexityEstimator>;
  readonly operationName?: string;
  readonly maxQueryNodes: number;
  // Errors detected during compilation (unknown fragments, fragment cycles).
  readonly compileErrors: ReadonlyArray<GraphQLError>;

  // Returns true only when the plan is safe to reuse for the given schema
  // instance / rule configuration. Query text identity is intentionally not
  // part of this check.
  isCompatibleWith(config: ComplexityPlanCompatibility): boolean;

  // Evaluates the plan for one request. All request-scoped state is local to
  // the call, so the same plan can be evaluated concurrently / repeatedly.
  estimate(options?: EstimateComplexityOptions): number;
}

interface FieldPlanNode {
  kind: 'Field';
  node: FieldNode;
  parentType: GraphQLCompositeType;
  // Precomputed possible type names of the parent type.
  possibleTypeNames: string[];
  // Resolved field (incl. introspection meta fields). Null for fields that
  // do not exist on the type: they are skipped, as in the direct path.
  field: GraphQLField<any, any> | null;
  // Precompiled child selections when the field type is composite.
  child: {
    type: GraphQLCompositeType;
    selections: PlanSelection[];
  } | null;
}

interface FragmentSpreadPlanNode {
  kind: 'FragmentSpread';
  node: FragmentSpreadNode;
  // Null when the referenced fragment is missing from the document.
  fragment: CompiledFragmentPlan | null;
}

interface InlineFragmentPlanNode {
  kind: 'InlineFragment';
  node: InlineFragmentNode;
  // Possible type names of the (resolved) inline fragment type condition.
  possibleTypeNames: string[];
  // False when the type condition does not resolve to a composite type.
  valid: boolean;
  selections: PlanSelection[];
}

type PlanSelection =
  | FieldPlanNode
  | FragmentSpreadPlanNode
  | InlineFragmentPlanNode;

interface CompiledOperationPlan {
  node: OperationDefinitionNode;
  rootType: GraphQLObjectType | undefined;
  selections: PlanSelection[];
}

interface CompiledFragmentPlan {
  name: string;
  // Null when the type condition does not resolve to a composite type.
  type: GraphQLCompositeType | null;
  possibleTypeNames: string[];
  selections: PlanSelection[];
}

export function compileComplexityPlan(
  schema: GraphQLSchema,
  document: DocumentNode,
  options: CompileComplexityPlanOptions
): ComplexityPlan {
  return new ComplexityPlanImpl(schema, document, options);
}

function possibleTypeNamesOf(
  schema: GraphQLSchema,
  type: GraphQLCompositeType
): string[] {
  if (isAbstractType(type)) {
    return schema.getPossibleTypes(type).map((t) => t.name);
  }
  return [type.name];
}

function resolveFieldDef(
  typeDef: GraphQLCompositeType,
  fieldNode: FieldNode
): GraphQLField<any, any> | null {
  switch (fieldNode.name.value) {
    case SchemaMetaFieldDef.name:
      return SchemaMetaFieldDef;
    case TypeMetaFieldDef.name:
      return TypeMetaFieldDef;
    case TypeNameMetaFieldDef.name:
      return TypeNameMetaFieldDef;
    default: {
      let fields: GraphQLFieldMap<any, any> = {};
      if (
        typeDef instanceof GraphQLObjectType ||
        typeDef instanceof GraphQLInterfaceType
      ) {
        fields = typeDef.getFields();
      }
      return fields[fieldNode.name.value] ?? null;
    }
  }
}

class PlanCompiler {
  private readonly fragmentDefs = new Map<string, FragmentDefinitionNode>();
  private readonly compiledFragments = new Map<string, CompiledFragmentPlan>();
  private readonly compilingFragments = new Set<string>();
  private readonly reportedCycles = new Set<string>();
  readonly compileErrors: GraphQLError[] = [];

  constructor(
    private readonly schema: GraphQLSchema,
    private readonly document: DocumentNode,
    private readonly onCompileError?: (error: GraphQLError) => void
  ) {
    for (const definition of document.definitions) {
      if (definition.kind === 'FragmentDefinition') {
        this.fragmentDefs.set(definition.name.value, definition);
      }
    }
  }

  private reportCompileError(error: GraphQLError): void {
    this.compileErrors.push(error);
    if (this.onCompileError) {
      this.onCompileError(error);
    }
  }

  compileOperations(operationName?: string): CompiledOperationPlan[] {
    const operations: CompiledOperationPlan[] = [];
    for (const definition of this.document.definitions) {
      if (definition.kind !== 'OperationDefinition') {
        continue;
      }
      if (
        typeof operationName === 'string' &&
        (!definition.name || definition.name.value !== operationName)
      ) {
        continue;
      }

      let rootType: GraphQLObjectType | undefined;
      switch (definition.operation) {
        case 'query':
          rootType = this.schema.getQueryType() ?? undefined;
          break;
        case 'mutation':
          rootType = this.schema.getMutationType() ?? undefined;
          break;
        case 'subscription':
          rootType = this.schema.getSubscriptionType() ?? undefined;
          break;
        default:
          throw new Error(
            `Query complexity could not be calculated for operation of type ${definition.operation}`
          );
      }

      operations.push({
        node: definition,
        rootType,
        selections: rootType
          ? this.compileSelectionSet(definition.selectionSet, rootType)
          : [],
      });
    }
    return operations;
  }

  private compileSelectionSet(
    selectionSet: OperationDefinitionNode['selectionSet'],
    typeDef: GraphQLCompositeType
  ): PlanSelection[] {
    return selectionSet.selections.map((childNode) =>
      this.compileSelection(childNode, typeDef)
    );
  }

  private compileSelection(
    childNode: FieldNode | FragmentSpreadNode | InlineFragmentNode,
    typeDef: GraphQLCompositeType
  ): PlanSelection {
    switch (childNode.kind) {
      case 'Field':
        return this.compileField(childNode, typeDef);
      case 'FragmentSpread':
        return this.compileFragmentSpread(childNode);
      case 'InlineFragment':
        return this.compileInlineFragment(childNode, typeDef);
      default:
        // Unreachable, mirrors the direct path's exhaustive switch.
        throw new Error('Unexpected selection node kind during plan compile');
    }
  }

  private compileField(
    node: FieldNode,
    typeDef: GraphQLCompositeType
  ): FieldPlanNode {
    const field = resolveFieldDef(typeDef, node);
    let child: FieldPlanNode['child'] = null;
    if (field && node.selectionSet) {
      const fieldType = getNamedType(field.type);
      if (isCompositeType(fieldType)) {
        child = {
          type: fieldType,
          selections: this.compileSelectionSet(node.selectionSet, fieldType),
        };
      }
    }
    return {
      kind: 'Field',
      node,
      parentType: typeDef,
      possibleTypeNames: possibleTypeNamesOf(this.schema, typeDef),
      field,
      child,
    };
  }

  private compileFragmentSpread(
    node: FragmentSpreadNode
  ): FragmentSpreadPlanNode {
    const fragmentName = node.name.value;
    const fragmentDef = this.fragmentDefs.get(fragmentName);
    if (!fragmentDef) {
      // Unknown fragment: other validation rules report this; estimation
      // skips the spread, matching the direct path.
      this.reportCompileError(
        new GraphQLError(`Unknown fragment "${fragmentName}".`)
      );
      return { kind: 'FragmentSpread', node, fragment: null };
    }
    return {
      kind: 'FragmentSpread',
      node,
      fragment: this.compileFragment(fragmentDef),
    };
  }

  private compileInlineFragment(
    node: InlineFragmentNode,
    parentType: GraphQLCompositeType
  ): InlineFragmentPlanNode {
    let fragmentType: GraphQLNamedType = parentType;
    if (node.typeCondition && node.typeCondition.name) {
      fragmentType = this.schema.getType(node.typeCondition.name.value);
      if (!isCompositeType(fragmentType)) {
        return {
          kind: 'InlineFragment',
          node,
          possibleTypeNames: [],
          valid: false,
          selections: [],
        };
      }
    }
    const compositeType = fragmentType as GraphQLCompositeType;
    return {
      kind: 'InlineFragment',
      node,
      possibleTypeNames: possibleTypeNamesOf(this.schema, compositeType),
      valid: true,
      selections: this.compileSelectionSet(node.selectionSet, compositeType),
    };
  }

  private compileFragment(
    fragmentDef: FragmentDefinitionNode
  ): CompiledFragmentPlan {
    const fragmentName = fragmentDef.name.value;
    const existing = this.compiledFragments.get(fragmentName);
    if (existing) {
      // Back edge into a fragment that is still being compiled: explicit
      // cycle. The runtime active-fragment set skips the spread; report it
      // once at compile time.
      if (this.compilingFragments.has(fragmentName)) {
        this.reportCycle(fragmentName);
      }
      return existing;
    }

    const fragmentType = this.schema.getType(
      fragmentDef.typeCondition.name.value
    );
    const type = isCompositeType(fragmentType) ? fragmentType : null;
    const fragmentPlan: CompiledFragmentPlan = {
      name: fragmentName,
      type,
      possibleTypeNames: type ? possibleTypeNamesOf(this.schema, type) : [],
      selections: [],
    };
    // Register before descending so cycle back edges terminate.
    this.compiledFragments.set(fragmentName, fragmentPlan);

    if (type) {
      this.compilingFragments.add(fragmentName);
      fragmentPlan.selections = this.compileSelectionSet(
        fragmentDef.selectionSet,
        type
      );
      this.compilingFragments.delete(fragmentName);
    }
    return fragmentPlan;
  }

  private reportCycle(fragmentName: string): void {
    if (this.reportedCycles.has(fragmentName)) {
      return;
    }
    this.reportedCycles.add(fragmentName);
    this.reportCompileError(
      new GraphQLError(
        `Cannot spread fragment "${fragmentName}" within itself.`
      )
    );
  }
}

class ComplexityPlanImpl implements ComplexityPlan {
  readonly estimators: ReadonlyArray<ComplexityEstimator>;
  readonly operationName?: string;
  readonly maxQueryNodes: number;
  readonly compileErrors: ReadonlyArray<GraphQLError>;
  readonly operations: CompiledOperationPlan[];
  readonly includeDirectiveDef: GraphQLDirective;
  readonly skipDirectiveDef: GraphQLDirective;

  constructor(
    readonly schema: GraphQLSchema,
    readonly document: DocumentNode,
    options: CompileComplexityPlanOptions
  ) {
    this.estimators = [...options.estimators];
    this.operationName = options.operationName;
    this.maxQueryNodes = options.maxQueryNodes ?? 10_000;
    this.includeDirectiveDef = this.schema.getDirective('include');
    this.skipDirectiveDef = this.schema.getDirective('skip');

    const compiler = new PlanCompiler(
      this.schema,
      this.document,
      options.onCompileError
    );
    this.operations = compiler.compileOperations(this.operationName);
    this.compileErrors = compiler.compileErrors;
  }

  isCompatibleWith(config: ComplexityPlanCompatibility): boolean {
    if (config.schema !== undefined && config.schema !== this.schema) {
      return false;
    }
    if (
      config.estimators !== undefined &&
      (config.estimators.length !== this.estimators.length ||
        config.estimators.some(
          (estimator, index) => estimator !== this.estimators[index]
        ))
    ) {
      return false;
    }
    if (
      typeof config.operationName === 'string' &&
      config.operationName !== this.operationName
    ) {
      return false;
    }
    if (
      config.maxQueryNodes !== undefined &&
      config.maxQueryNodes !== this.maxQueryNodes
    ) {
      return false;
    }
    return true;
  }

  estimate(options: EstimateComplexityOptions = {}): number {
    this.assertCompatible(options);

    const estimator = new PlanEstimator(this, options);
    return estimator.run();
  }

  private assertCompatible(options: EstimateComplexityOptions): void {
    if (options.schema !== undefined && options.schema !== this.schema) {
      throw new Error(
        'Complexity plan was compiled against a different schema instance. ' +
          'Recompile the plan for the current schema instead of reusing it.'
      );
    }
    if (
      options.estimators !== undefined &&
      !this.isCompatibleWith({ estimators: options.estimators })
    ) {
      throw new Error(
        'Complexity plan was compiled with different complexity estimators. ' +
          'Recompile the plan for the current estimator configuration.'
      );
    }
    if (
      options.maxQueryNodes !== undefined &&
      options.maxQueryNodes !== this.maxQueryNodes
    ) {
      throw new Error(
        'Complexity plan was compiled with a different maxQueryNodes limit. ' +
          'Recompile the plan for the current limit.'
      );
    }
  }
}

/**
 * Request-scoped evaluation state. A fresh instance is created per
 * estimate() call, which keeps the compiled plan itself read-only and safe
 * to share across parallel requests.
 */
class PlanEstimator {
  private complexity = 0;
  private evaluatedNodes = 0;
  private variableValues: Record<string, any> = {};
  private readonly activeFragments = new Set<string>();
  private readonly errors: GraphQLError[] = [];
  private readonly maximumComplexity: number;

  constructor(
    private readonly plan: ComplexityPlanImpl,
    private readonly options: EstimateComplexityOptions
  ) {
    this.maximumComplexity = options.maximumComplexity ?? Infinity;
  }

  run(): number {
    const operationName = this.options.operationName ?? this.plan.operationName;

    for (const operation of this.plan.operations) {
      if (
        typeof operationName === 'string' &&
        (!operation.node.name || operation.node.name.value !== operationName)
      ) {
        continue;
      }

      // Get variable values from variables that are passed from options,
      // merged with default values defined in the operation
      const { variableValues, errors } = getOperationVariableValues(
        this.plan.schema,
        // Input argument is not readonly in older graphql versions
        operation.node.variableDefinitions
          ? [...operation.node.variableDefinitions]
          : [],
        this.options.variables ?? {}
      );
      if (errors && errors.length) {
        // Input validation errors: report and abort this operation
        errors.forEach((error) => this.errors.push(error));
        continue;
      }
      this.variableValues = variableValues;

      this.complexity += this.selectionSetComplexity(operation.selections);

      if (this.options.onComplete) {
        this.options.onComplete(this.complexity);
      }

      if (this.complexity > this.maximumComplexity) {
        this.errors.push(this.createError());
      }
    }

    // Throw first error if any (same behavior as getComplexity)
    if (this.errors.length) {
      throw this.errors.pop();
    }

    return this.complexity;
  }

  private selectionSetComplexity(selections: PlanSelection[]): number {
    const complexities: ComplexityMap = {};

    for (const selection of selections) {
      this.evaluatedNodes++;
      if (this.evaluatedNodes >= this.plan.maxQueryNodes) {
        throw new GraphQLError(
          'Query exceeds the maximum allowed number of nodes.'
        );
      }

      if (
        !shouldIncludeNode(
          selection.node,
          this.plan.includeDirectiveDef,
          this.plan.skipDirectiveDef,
          this.variableValues
        )
      ) {
        continue;
      }

      switch (selection.kind) {
        case 'Field':
          this.estimateField(selection, complexities);
          break;
        case 'FragmentSpread':
          this.estimateFragmentSpread(selection, complexities);
          break;
        case 'InlineFragment':
          this.estimateInlineFragment(selection, complexities);
          break;
      }
    }

    // Only return max complexity of all possible types
    return Math.max(...Object.values(complexities), 0);
  }

  private estimateField(
    selection: FieldPlanNode,
    complexities: ComplexityMap
  ): void {
    const field = selection.field;
    // Invalid field, should be caught by other validation rules
    if (!field) {
      return;
    }

    // Get arguments
    let args: { [key: string]: any };
    try {
      args = getArgumentValues(
        field,
        selection.node,
        getExecutionVariableValues(this.variableValues)
      );
    } catch (e) {
      this.errors.push(e as GraphQLError);
      return;
    }

    // Check if we have child complexity
    const childComplexity = selection.child
      ? this.selectionSetComplexity(selection.child.selections)
      : 0;

    // Run estimators one after another and return first valid complexity
    // score
    const score = resolveFieldComplexity(this.plan.estimators, {
      childComplexity,
      args,
      field,
      node: selection.node,
      type: selection.parentType,
      context: this.options.context,
    });
    if (score === undefined) {
      this.errors.push(
        new GraphQLError(
          `No complexity could be calculated for field ${selection.parentType.name}.${field.name}. ` +
            'At least one complexity estimator has to return a complexity score.'
        )
      );
      return;
    }
    addComplexities(score, complexities, selection.possibleTypeNames);
  }

  private estimateFragmentSpread(
    selection: FragmentSpreadPlanNode,
    complexities: ComplexityMap
  ): void {
    const fragment = selection.fragment;
    // Unknown fragment or invalid fragment type, should be caught by other
    // validation rules
    if (!fragment || !fragment.type) {
      return;
    }
    // Circular fragment reference — skip to avoid infinite recursion
    if (this.activeFragments.has(fragment.name)) {
      return;
    }
    this.activeFragments.add(fragment.name);
    const fragmentComplexity = this.selectionSetComplexity(fragment.selections);
    this.activeFragments.delete(fragment.name);
    addComplexities(
      fragmentComplexity,
      complexities,
      fragment.possibleTypeNames
    );
  }

  private estimateInlineFragment(
    selection: InlineFragmentPlanNode,
    complexities: ComplexityMap
  ): void {
    if (!selection.valid) {
      return;
    }
    const fragmentComplexity = this.selectionSetComplexity(
      selection.selections
    );
    addComplexities(
      fragmentComplexity,
      complexities,
      selection.possibleTypeNames
    );
  }

  private createError(): GraphQLError {
    if (typeof this.options.createError === 'function') {
      return this.options.createError(this.maximumComplexity, this.complexity);
    }
    return new GraphQLError(
      queryComplexityMessage(this.maximumComplexity, this.complexity)
    );
  }
}
