#!/usr/bin/env tsx
import { writeFileSync } from 'fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { GatewayConfig } from '../src/config/schema.js';

const jsonSchema = zodToJsonSchema(GatewayConfig, {
  name: 'AirlockConfig',
  $refStrategy: 'none',
});

writeFileSync('schema.json', JSON.stringify(jsonSchema, null, 2) + '\n');
console.log('Generated schema.json');
