import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseOpenApiSpec } from '../src/backend/openapi/parser.js';

const PETSTORE_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.example.com/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Max results' },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  tag: { type: 'string' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        summary: 'Get a pet by ID',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        operationId: 'deletePet',
        summary: 'Delete a pet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'Deleted' } },
      },
    },
  },
};

describe('parseOpenApiSpec()', () => {
  let dir: string;

  function writeSpec(spec: unknown = PETSTORE_SPEC): string {
    dir = mkdtempSync(join(tmpdir(), 'openapi-test-'));
    const specPath = join(dir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(spec));
    return specPath;
  }

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses operations with operationId-based names', async () => {
    const path = writeSpec();
    const result = await parseOpenApiSpec(path);

    expect(result.baseUrl).toBe('https://petstore.example.com/v1');
    const names = result.operations.map((op) => op.name);
    expect(names).toContain('listPets');
    expect(names).toContain('createPet');
    expect(names).toContain('getPet');
    expect(names).toContain('deletePet');
  });

  it('extracts path params', async () => {
    const path = writeSpec();
    const result = await parseOpenApiSpec(path);

    const getPet = result.operations.find((op) => op.name === 'getPet')!;
    expect(getPet.pathParams).toEqual(['petId']);
    expect(getPet.inputSchema.properties).toHaveProperty('petId');
  });

  it('extracts query params', async () => {
    const path = writeSpec();
    const result = await parseOpenApiSpec(path);

    const listPets = result.operations.find((op) => op.name === 'listPets')!;
    expect(listPets.queryParams).toEqual(['limit']);
  });

  it('extracts request body schema', async () => {
    const path = writeSpec();
    const result = await parseOpenApiSpec(path);

    const createPet = result.operations.find((op) => op.name === 'createPet')!;
    expect(createPet.hasBody).toBe(true);
    expect(createPet.inputSchema.properties).toHaveProperty('name');
    expect(createPet.inputSchema.properties).toHaveProperty('tag');
    expect(createPet.inputSchema.required).toContain('name');
  });

  it('applies include filter', async () => {
    const path = writeSpec();
    const result = await parseOpenApiSpec(path, { include: ['GET /pets'] });

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].name).toBe('listPets');
  });

  it('applies exclude filter', async () => {
    const path = writeSpec();
    const result = await parseOpenApiSpec(path, { exclude: ['DELETE *'] });

    const names = result.operations.map((op) => op.name);
    expect(names).not.toContain('deletePet');
    expect(names).toContain('listPets');
  });

  it('uses base_url override', async () => {
    const path = writeSpec();
    const result = await parseOpenApiSpec(path, { baseUrlOverride: 'https://custom.api.com' });

    expect(result.baseUrl).toBe('https://custom.api.com');
  });

  it('generates method+path name when no operationId', async () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/users/{userId}': {
          get: {
            summary: 'Get user',
            parameters: [
              { name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const path = writeSpec(spec);
    const result = await parseOpenApiSpec(path);

    expect(result.operations[0].name).toBe('get_users_by_userId');
  });
});
