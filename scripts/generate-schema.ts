#!/usr/bin/env tsx
import { writeFileSync } from 'fs';
import { z } from 'zod';
import { GatewayConfig } from '../src/config/schema.js';

// `io: 'input'` describes what a user writes in YAML (fields with defaults stay optional), which is
// what editors validate against.
const jsonSchema = z.toJSONSchema(GatewayConfig, {
  io: 'input',
  target: 'draft-7',
  unrepresentable: 'any',
});

writeFileSync(
  'schema.json',
  JSON.stringify({ title: 'AirlockConfig', ...jsonSchema }, null, 2) + '\n'
);
console.log('Generated schema.json');
