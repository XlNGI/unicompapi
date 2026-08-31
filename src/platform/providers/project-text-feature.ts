import {
  DEEPSEEK_CONSTRAINT_SET_ID,
  DEEPSEEK_RESULT_SCHEMA_ID,
  deepSeekChatParameterSchema,
  deepSeekReasoningParameterSchema,
  deepSeekUsageSchema
} from './deepseek/deepseek-contracts';
import {
  NEWAPI_CHAT_RESULT_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  NEWAPI_TEXT_CONSTRAINT_SET_ID,
  newApiChatUsageSchema,
  newApiDefaultTextChatParameterSchema,
  newApiDefaultTextReasoningParameterSchema
} from './newapi/newapi-contracts';
import {
  kimiK3TextChatParameterSchema,
  kimiK3TextReasoningParameterSchema
} from './kimi/kimi-contracts';
import {
  uniCompApiTextChatParameterSchema,
  uniCompApiTextReasoningParameterSchema
} from './newapi/unicompapi-model-capabilities';
import type { ProviderFeatureContractV1 } from './provider-registry-feature-candidates';

export function createTextProviderFeatureContracts(): readonly ProviderFeatureContractV1[] {
  return [
    {
      parameterSchema: deepSeekChatParameterSchema,
      resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: deepSeekUsageSchema,
      constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: deepSeekReasoningParameterSchema,
      resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: deepSeekUsageSchema,
      constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: newApiDefaultTextChatParameterSchema,
      resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiChatUsageSchema,
      constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: newApiDefaultTextReasoningParameterSchema,
      resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiChatUsageSchema,
      constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: kimiK3TextChatParameterSchema,
      resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiChatUsageSchema,
      constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: kimiK3TextReasoningParameterSchema,
      resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiChatUsageSchema,
      constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: uniCompApiTextChatParameterSchema,
      resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiChatUsageSchema,
      constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: uniCompApiTextReasoningParameterSchema,
      resultSchemaId: NEWAPI_CHAT_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiChatUsageSchema,
      constraintSetId: NEWAPI_TEXT_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    }
  ];
}

export {
  NEWAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID
};
