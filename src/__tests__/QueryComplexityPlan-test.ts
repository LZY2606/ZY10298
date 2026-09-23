/**
 * Tests for the compiled traversal plan (compileComplexityPlan) and its
 * parity with the direct getComplexity / QueryComplexity visitor path.
 */

import { parse, buildSchema, GraphQLError, GraphQLSchema } from 'graphql';

import { expect } from 'chai';

import schema from './fixtures/schema.js';

import {
  getComplexity,
  ComplexityEstimator,
  ComplexityEstimatorArgs,
} from '../QueryComplexity.js';
import {
  compileComplexityPlan,
  simpleEstimator,
  fieldExtensionsEstimator,
  directiveEstimator,
  ComplexityPlan,
} from '../index.js';

describe('QueryComplexityPlan', () => {
  const directComplexity = (options: {
    query: string;
    variables?: Record<string, unknown>;
    estimators: ComplexityEstimator[];
    operationName?: string;
    context?: Record<string, unknown>;
    maxQueryNodes?: number;
    targetSchema?: GraphQLSchema;
  }): number =>
    getComplexity({
      schema: options.targetSchema ?? schema,
      query: parse(options.query),
      variables: options.variables,
      operationName: options.operationName,
      context: options.context,
      estimators: options.estimators,
      maxQueryNodes: options.maxQueryNodes,
    });

  describe('parity with the direct path', () => {
    const cases: Array<{
      name: string;
      query: string;
      variables?: Record<string, unknown>;
      estimators?: ComplexityEstimator[];
    }> = [
      {
        name: 'simple scalar fields',
        query: 'query { scalar complexScalar }',
      },
      {
        name: 'nested lists',
        query: 'query { list { scalar list { scalar } } }',
      },
      {
        name: 'named fragments',
        query: 'query { ...F } fragment F on Query { scalar complexScalar }',
      },
      {
        name: 'inline fragments with and without type condition',
        query: 'query { ... on Query { scalar } ... { complexScalar } }',
      },
      {
        name: 'union types',
        query:
          'query { union { ... on Item { scalar } ... on SecondItem { name } } }',
      },
      {
        name: 'interface types',
        query: 'query { interface { name } }',
      },
      {
        name: 'introspection meta fields',
        query: 'query { __typename scalar }',
      },
      {
        name: 'unknown fields are skipped',
        query: 'query { doesNotExist scalar }',
      },
      {
        name: 'skip/include with literal values',
        query:
          'query { scalar @skip(if: true) complexScalar @include(if: false) name }',
      },
      {
        name: 'skip/include with variables (included)',
        query:
          'query Q($flag: Boolean!) { scalar @skip(if: $flag) complexScalar @include(if: $flag) }',
        variables: { flag: true },
      },
      {
        name: 'skip/include with variables (excluded)',
        query:
          'query Q($flag: Boolean!) { scalar @skip(if: $flag) complexScalar @include(if: $flag) }',
        variables: { flag: false },
      },
      {
        name: 'default variable values',
        query:
          'query Q($count: Int = 3) { variableScalar(count: $count) { scalar } }',
        estimators: [fieldExtensionsEstimator(), simpleEstimator()],
      },
      {
        name: 'explicit variable values',
        query:
          'query Q($count: Int = 3) { variableScalar(count: $count) { scalar } }',
        variables: { count: 7 },
        estimators: [fieldExtensionsEstimator(), simpleEstimator()],
      },
      {
        name: 'enum input arguments',
        query: 'query Q($e: RGB) { enumInputArg(enum: $e) }',
        variables: { e: 'GREEN' },
      },
      {
        name: 'full estimator chain with directive passthrough',
        query: 'query { variableList(count: 2) { scalar } }',
        estimators: [
          directiveEstimator(),
          fieldExtensionsEstimator(),
          simpleEstimator(),
        ],
      },
    ];

    cases.forEach(({ name, query, variables, estimators }) => {
      it(`calculates the same complexity: ${name}`, () => {
        const usedEstimators = estimators ?? [simpleEstimator()];
        const document = parse(query);
        const plan = compileComplexityPlan(schema, document, {
          estimators: usedEstimators,
        });

        const expected = getComplexity({
          schema,
          query: document,
          variables,
          estimators: usedEstimators,
        });

        expect(plan.estimate({ variables })).to.equal(expected);
        // Repeated evaluation of the same plan is stable
        expect(plan.estimate({ variables })).to.equal(expected);
      });
    });

    it('keeps deprecated fields and custom scalars as-is', () => {
      const customSchema = buildSchema(`
        scalar Custom
        type Query {
          old: String @deprecated(reason: "use new")
          new: String
          custom: Custom
        }
      `);
      const query = 'query { old new custom }';
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(customSchema, parse(query), {
        estimators,
      });

      expect(plan.estimate()).to.equal(
        directComplexity({ query, estimators, targetSchema: customSchema })
      );
    });
  });

  describe('estimator context and visit counts', () => {
    it('passes identical estimator arguments in identical order', () => {
      const query = `
        query Q($count: Int = 2) {
          variableScalar(count: $count) {
            scalar
            variableList(count: 2) { scalar }
          }
          ...F
        }
        fragment F on Query { complexScalar }
      `;
      const document = parse(query);
      const context = { user: 'tester' };

      const record = () => {
        const calls: Array<Record<string, unknown>> = [];
        const estimator: ComplexityEstimator = (
          args: ComplexityEstimatorArgs
        ) => {
          calls.push({
            type: args.type.name,
            field: args.field.name,
            args: args.args,
            childComplexity: args.childComplexity,
            context: args.context,
          });
          return 1 + args.childComplexity;
        };
        return { calls, estimator };
      };

      const direct = record();
      const directResult = getComplexity({
        schema,
        query: document,
        estimators: [direct.estimator],
        context,
      });

      const planned = record();
      const plan = compileComplexityPlan(schema, document, {
        estimators: [planned.estimator],
      });
      const planResult = plan.estimate({ context });

      expect(planResult).to.equal(directResult);
      expect(planned.calls.length).to.equal(direct.calls.length);
      expect(planned.calls).to.deep.equal(direct.calls);
    });

    it('short-circuits estimators in the same order', () => {
      const query = 'query { scalar complexScalar }';
      const document = parse(query);

      const run = () => {
        const calls: string[] = [];
        const first: ComplexityEstimator = () => {
          calls.push('first');
          return undefined;
        };
        const second: ComplexityEstimator = () => {
          calls.push('second');
          return 5;
        };
        const third: ComplexityEstimator = () => {
          calls.push('third');
          return 100;
        };
        return { calls, estimators: [first, second, third] };
      };

      const direct = run();
      const directResult = getComplexity({
        schema,
        query: document,
        estimators: direct.estimators,
      });

      const planned = run();
      const plan = compileComplexityPlan(schema, document, {
        estimators: planned.estimators,
      });
      const planResult = plan.estimate();

      expect(planResult).to.equal(directResult);
      expect(planned.calls).to.deep.equal(direct.calls);
      // third estimator is never reached because second returns a score
      expect(planned.calls).to.not.include('third');
    });

    it('re-evaluates the same plan with changing variables', () => {
      const query = `
        query Q($count: Int!, $show: Boolean!) {
          variableScalar(count: $count) @include(if: $show) { scalar }
        }
      `;
      const document = parse(query);
      const estimators = [fieldExtensionsEstimator(), simpleEstimator()];
      const plan = compileComplexityPlan(schema, document, { estimators });

      const variableSets: Array<Record<string, unknown>> = [
        { count: 1, show: true },
        { count: 5, show: true },
        { count: 5, show: false },
        { count: 1, show: true },
      ];

      variableSets.forEach((variables) => {
        expect(plan.estimate({ variables })).to.equal(
          getComplexity({ schema, query: document, variables, estimators })
        );
      });
    });

    it('keeps request state isolated between interleaved estimates', () => {
      const query = `
        query Q($show: Boolean!) {
          scalar @include(if: $show)
          complexScalar
        }
      `;
      const document = parse(query);
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schema, document, { estimators });

      const contexts = [{ request: 1 }, { request: 2 }];
      const seenContexts: Array<unknown> = [];
      const contextEstimator: ComplexityEstimator = (args) => {
        seenContexts.push(args.context);
        return 1;
      };
      const contextPlan = compileComplexityPlan(schema, document, {
        estimators: [contextEstimator],
      });

      // Interleave estimates as parallel requests would
      const firstShown = plan.estimate({ variables: { show: true } });
      const firstHidden = plan.estimate({ variables: { show: false } });
      const secondShown = plan.estimate({ variables: { show: true } });

      expect(firstShown).to.equal(2);
      expect(firstHidden).to.equal(1);
      expect(secondShown).to.equal(2);

      contextPlan.estimate({ variables: { show: true }, context: contexts[0] });
      contextPlan.estimate({ variables: { show: true }, context: contexts[1] });
      expect(seenContexts[0]).to.equal(contexts[0]);
      expect(seenContexts[seenContexts.length - 1]).to.equal(contexts[1]);
    });
  });

  describe('error behavior', () => {
    it('throws the same maxQueryNodes error as the direct path', () => {
      const query = 'query { scalar complexScalar name }';
      const document = parse(query);
      const estimators = [simpleEstimator()];

      expect(() =>
        getComplexity({
          schema,
          query: document,
          estimators,
          maxQueryNodes: 2,
        })
      ).to.throw('Query exceeds the maximum allowed number of nodes.');

      const plan = compileComplexityPlan(schema, document, {
        estimators,
        maxQueryNodes: 2,
      });
      expect(() => plan.estimate()).to.throw(
        GraphQLError,
        'Query exceeds the maximum allowed number of nodes.'
      );
    });

    it('reports missing estimator scores identically', () => {
      const query = 'query { scalar }';
      const document = parse(query);
      const estimators: ComplexityEstimator[] = [() => undefined];

      expect(() =>
        getComplexity({ schema, query: document, estimators })
      ).to.throw('No complexity could be calculated for field Query.scalar');

      const plan = compileComplexityPlan(schema, document, { estimators });
      expect(() => plan.estimate()).to.throw(
        GraphQLError,
        'No complexity could be calculated for field Query.scalar'
      );
    });

    it('reports argument coercion errors identically', () => {
      const query = 'query { requiredArgs { scalar } }';
      const document = parse(query);
      const estimators = [simpleEstimator()];

      let directError: Error | undefined;
      try {
        getComplexity({ schema, query: document, estimators });
      } catch (error) {
        directError = error as Error;
      }
      expect(directError).to.be.instanceOf(GraphQLError);

      const plan = compileComplexityPlan(schema, document, { estimators });
      let planError: Error | undefined;
      try {
        plan.estimate();
      } catch (error) {
        planError = error as Error;
      }
      expect(planError).to.be.instanceOf(GraphQLError);
      expect(planError?.message).to.equal(directError?.message);
    });

    it('reports variable coercion errors identically', () => {
      const query =
        'query Q($count: Int!) { variableScalar(count: $count) { scalar } }';
      const document = parse(query);
      const estimators = [simpleEstimator()];

      let directError: Error | undefined;
      try {
        getComplexity({ schema, query: document, estimators });
      } catch (error) {
        directError = error as Error;
      }
      expect(directError).to.be.instanceOf(GraphQLError);

      const plan = compileComplexityPlan(schema, document, { estimators });
      let planError: Error | undefined;
      try {
        plan.estimate();
      } catch (error) {
        planError = error as Error;
      }
      expect(planError).to.be.instanceOf(GraphQLError);
      expect(planError?.message).to.equal(directError?.message);
    });

    it('enforces maximumComplexity with createError and onComplete', () => {
      const query = 'query { scalar complexScalar }';
      const document = parse(query);
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schema, document, { estimators });

      const completed: number[] = [];
      expect(() =>
        plan.estimate({
          maximumComplexity: 1,
          onComplete: (complexity) => completed.push(complexity),
        })
      ).to.throw(
        GraphQLError,
        'The query exceeds the maximum complexity of 1. Actual complexity is 2'
      );
      expect(completed).to.deep.equal([2]);

      expect(() =>
        plan.estimate({
          maximumComplexity: 1,
          createError: (max, actual) =>
            new GraphQLError(`custom ${max}/${actual}`),
        })
      ).to.throw(GraphQLError, 'custom 1/2');

      // Below the threshold: no error, complexity returned
      expect(plan.estimate({ maximumComplexity: 10 })).to.equal(2);
    });
  });

  describe('compile-phase detection', () => {
    it('detects self-referencing fragment cycles at compile time', () => {
      const query = `
        query { ...A }
        fragment A on Query { scalar ...A }
      `;
      const document = parse(query);
      const estimators = [simpleEstimator()];

      const compileErrors: GraphQLError[] = [];
      const plan = compileComplexityPlan(schema, document, {
        estimators,
        onCompileError: (error) => compileErrors.push(error),
      });

      expect(compileErrors).to.have.length(1);
      expect(compileErrors[0].message).to.contain(
        'Cannot spread fragment "A" within itself'
      );
      expect(plan.compileErrors).to.have.length(1);

      // Estimation still matches the direct path (cycle edge is skipped)
      expect(plan.estimate()).to.equal(
        getComplexity({ schema, query: document, estimators })
      );
    });

    it('detects mutually recursive fragment cycles at compile time', () => {
      const query = `
        query { ...A }
        fragment A on Query { scalar ...B }
        fragment B on Query { scalar ...A }
      `;
      const document = parse(query);
      const estimators = [simpleEstimator()];

      const plan = compileComplexityPlan(schema, document, { estimators });

      expect(plan.compileErrors).to.have.length(1);
      expect(plan.compileErrors[0].message).to.contain('within itself');
      expect(plan.estimate()).to.equal(
        getComplexity({ schema, query: document, estimators })
      );
    });

    it('detects missing fragments at compile time and skips them', () => {
      const query = 'query { ...Missing scalar }';
      const document = parse(query);
      const estimators = [simpleEstimator()];

      const compileErrors: GraphQLError[] = [];
      const plan = compileComplexityPlan(schema, document, {
        estimators,
        onCompileError: (error) => compileErrors.push(error),
      });

      expect(compileErrors).to.have.length(1);
      expect(compileErrors[0].message).to.contain('Unknown fragment "Missing"');

      // Missing fragments do not become estimate-phase errors
      expect(plan.estimate()).to.equal(
        getComplexity({ schema, query: document, estimators })
      );
    });
  });

  describe('multiple operations', () => {
    const query = `
      query A { scalar }
      query B { complexScalar }
    `;

    it('selects operations by name like the direct path', () => {
      const document = parse(query);
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schema, document, { estimators });

      expect(plan.estimate({ operationName: 'A' })).to.equal(
        getComplexity({
          schema,
          query: document,
          estimators,
          operationName: 'A',
        })
      );
      expect(plan.estimate({ operationName: 'B' })).to.equal(
        getComplexity({
          schema,
          query: document,
          estimators,
          operationName: 'B',
        })
      );
      // Without an operation name all operations are evaluated
      expect(plan.estimate()).to.equal(
        getComplexity({ schema, query: document, estimators })
      );
    });

    it('can be compiled for a single operation', () => {
      const document = parse(query);
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schema, document, {
        estimators,
        operationName: 'B',
      });

      expect(plan.estimate()).to.equal(
        getComplexity({
          schema,
          query: document,
          estimators,
          operationName: 'B',
        })
      );
      expect(plan.isCompatibleWith({ operationName: 'B' })).to.equal(true);
      expect(plan.isCompatibleWith({ operationName: 'A' })).to.equal(false);
    });
  });

  describe('schema and configuration compatibility', () => {
    const sdl = 'type Query { a: String b: String }';
    const query = 'query { a b }';

    it('rejects reuse with a different schema of the same structure', () => {
      const schemaA = buildSchema(sdl);
      const schemaB = buildSchema(sdl);
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schemaA, parse(query), {
        estimators,
      });

      // Identical query text and identical structure are not sufficient:
      // compatibility requires the same schema instance.
      expect(plan.isCompatibleWith({ schema: schemaA })).to.equal(true);
      expect(plan.isCompatibleWith({ schema: schemaB })).to.equal(false);
      expect(() => plan.estimate({ schema: schemaB })).to.throw(
        /different schema instance/
      );
    });

    it('rejects reuse with a same-named schema of different structure', () => {
      const schemaA = buildSchema('type Query { a: String b: String }');
      const schemaB = buildSchema(
        'type Query { a: String b: Int c: [String] }'
      );
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schemaA, parse(query), {
        estimators,
      });

      expect(plan.isCompatibleWith({ schema: schemaB })).to.equal(false);
      expect(() => plan.estimate({ schema: schemaB })).to.throw(
        /different schema instance/
      );
    });

    it('rejects reuse with incompatible estimator configuration', () => {
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schema, parse(query), {
        estimators,
      });

      expect(plan.isCompatibleWith({ estimators })).to.equal(true);
      expect(
        plan.isCompatibleWith({ estimators: [simpleEstimator()] })
      ).to.equal(false);
      expect(
        plan.isCompatibleWith({
          estimators: [simpleEstimator(), fieldExtensionsEstimator()],
        })
      ).to.equal(false);
      expect(() => plan.estimate({ estimators: [simpleEstimator()] })).to.throw(
        /different complexity estimators/
      );
    });

    it('rejects reuse with a different maxQueryNodes limit', () => {
      const estimators = [simpleEstimator()];
      const plan = compileComplexityPlan(schema, parse(query), {
        estimators,
        maxQueryNodes: 100,
      });

      expect(plan.isCompatibleWith({ maxQueryNodes: 100 })).to.equal(true);
      expect(plan.isCompatibleWith({ maxQueryNodes: 50 })).to.equal(false);
      expect(() => plan.estimate({ maxQueryNodes: 50 })).to.throw(
        /different maxQueryNodes/
      );
    });
  });

  describe('cache eviction and recompilation', () => {
    it('recompiles deterministically after cache eviction', () => {
      const query = `
        query Q($count: Int = 2) {
          variableScalar(count: $count) { scalar }
          ...F
        }
        fragment F on Query { complexScalar }
      `;
      const variables = { count: 4 };

      const calls: Array<Record<string, unknown>> = [];
      const recordingEstimator: ComplexityEstimator = (
        args: ComplexityEstimatorArgs
      ) => {
        calls.push({
          type: args.type.name,
          field: args.field.name,
          args: args.args,
          childComplexity: args.childComplexity,
        });
        return undefined; // fall through to the remaining estimators
      };
      const estimators: ComplexityEstimator[] = [
        recordingEstimator,
        fieldExtensionsEstimator(),
        simpleEstimator(),
      ];

      const cache = new Map<string, ComplexityPlan>();
      const getPlan = (): ComplexityPlan => {
        const cached = cache.get(query);
        if (cached && cached.isCompatibleWith({ schema, estimators })) {
          return cached;
        }
        const plan = compileComplexityPlan(schema, parse(query), {
          estimators,
        });
        cache.set(query, plan);
        return plan;
      };

      const firstPlan = getPlan();
      calls.length = 0;
      const firstResult = firstPlan.estimate({ variables });
      const firstCalls = calls.slice();

      // Evict the cached plan: the next lookup has to recompile
      cache.clear();

      const secondPlan = getPlan();
      expect(secondPlan).to.not.equal(firstPlan);
      calls.length = 0;
      const secondResult = secondPlan.estimate({ variables });
      const secondCalls = calls.slice();

      // Recompilation is deterministic: same cost, same estimator visits
      expect(secondResult).to.equal(firstResult);
      expect(secondCalls).to.deep.equal(firstCalls);

      // And both match the direct path
      calls.length = 0;
      const directResult = getComplexity({
        schema,
        query: parse(query),
        variables,
        estimators,
      });
      expect(firstResult).to.equal(directResult);
      expect(calls).to.deep.equal(firstCalls);
    });
  });
});
