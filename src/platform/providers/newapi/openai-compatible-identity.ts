import {
  NEWAPI_COMPATIBLE_TEMPLATE_ID,
  NEWAPI_CREDENTIAL_SCHEMA_ID,
  NEWAPI_ENDPOINT_POLICY_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION
} from './newapi-contracts';
import {
  UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION
} from './unicompapi-contracts';
import {
  KIMI_ENDPOINT_POLICY_ID,
  KIMI_PROVIDER_PACKAGE_ID,
  KIMI_PROVIDER_PACKAGE_VERSION,
  KIMI_CREDENTIAL_SCHEMA_ID,
  KIMI_OFFICIAL_TEMPLATE_ID
} from '../kimi/kimi-contracts';

export interface OpenAiCompatiblePackageIdentity {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly templateId: string;
  readonly credentialSchemaId: string;
  readonly endpointPolicyId: string;
}

const OPENAI_COMPATIBLE_PACKAGES: readonly OpenAiCompatiblePackageIdentity[] = [
  {
    packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
    templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
    credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
    endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID
  },
  {
    packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
    packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
    templateId: UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
    credentialSchemaId: UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
    endpointPolicyId: UNICOMPAPI_ENDPOINT_POLICY_ID
  },
  {
    packageId: KIMI_PROVIDER_PACKAGE_ID,
    packageVersion: KIMI_PROVIDER_PACKAGE_VERSION,
    templateId: KIMI_OFFICIAL_TEMPLATE_ID,
    credentialSchemaId: KIMI_CREDENTIAL_SCHEMA_ID,
    endpointPolicyId: KIMI_ENDPOINT_POLICY_ID
  }
];

export function matchOpenAiCompatiblePackage(input: {
  readonly packageId?: string;
  readonly packageVersion?: string;
  readonly templateId?: string;
  readonly credentialSchemaId?: string;
  readonly credentialSchemaVersion?: number;
  readonly endpointPolicyId?: string;
  readonly endpointPolicyRevision?: number;
}): OpenAiCompatiblePackageIdentity | undefined {
  if (input.credentialSchemaVersion !== 1 || input.endpointPolicyRevision !== 1) {
    return undefined;
  }
  return OPENAI_COMPATIBLE_PACKAGES.find(
    (identity) =>
      identity.packageId === input.packageId &&
      identity.packageVersion === input.packageVersion &&
      identity.templateId === input.templateId &&
      identity.credentialSchemaId === input.credentialSchemaId &&
      identity.endpointPolicyId === input.endpointPolicyId
  );
}

export function isOpenAiCompatibleCredentialSchemaId(schemaId: string): boolean {
  return OPENAI_COMPATIBLE_PACKAGES.some(
    (identity) => identity.credentialSchemaId === schemaId
  );
}

export function isOpenAiCompatiblePackageId(packageId: string): boolean {
  return OPENAI_COMPATIBLE_PACKAGES.some((identity) => identity.packageId === packageId);
}

export function isOpenAiCompatiblePackageVersion(
  packageId: string,
  packageVersion: string
): boolean {
  return OPENAI_COMPATIBLE_PACKAGES.some(
    (identity) =>
      identity.packageId === packageId &&
      identity.packageVersion === packageVersion
  );
}

export function isOpenAiCompatibleEndpointPolicyId(policyId: string): boolean {
  return OPENAI_COMPATIBLE_PACKAGES.some(
    (identity) => identity.endpointPolicyId === policyId
  );
}
