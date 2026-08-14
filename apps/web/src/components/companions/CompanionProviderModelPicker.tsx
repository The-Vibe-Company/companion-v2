"use client";

import type { CompanionProvidersResponse } from "@companion/contracts";

export function providerDefaultModel(
  providers: CompanionProvidersResponse,
  providerId: string,
): string {
  return providers.catalog
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => model.default)?.id
    ?? providers.catalog.find((provider) => provider.id === providerId)?.models[0]?.id
    ?? "";
}

export function providerSelectedModel(
  providers: CompanionProvidersResponse,
  providerId: string,
  modelId: string | null,
): string {
  const provider = providers.catalog.find((candidate) => candidate.id === providerId);
  return modelId && provider?.models.some((model) => model.id === modelId)
    ? modelId
    : providerDefaultModel(providers, providerId);
}

export function CompanionProviderModelPicker({
  providers,
  providerId,
  modelId,
  namePrefix,
  descriptionId,
  disabled = false,
  onChange,
}: {
  providers: CompanionProvidersResponse;
  providerId: string;
  modelId: string;
  namePrefix: string;
  descriptionId?: string;
  disabled?: boolean;
  onChange: (selection: { providerId: string; modelId: string }) => void;
}) {
  const providerName = (id: string) =>
    providers.catalog.find((provider) => provider.id === id)?.name ?? id;
  const selectedProvider = providers.catalog.find((provider) => provider.id === providerId);

  return (
    <div className="companions-provider-model-picker">
      <fieldset
        className="companions-picker"
        disabled={disabled}
        aria-describedby={descriptionId}
      >
        <legend>1. Provider</legend>
        {providers.connections.map((connection) => (
          <label
            key={connection.provider_id}
            className={
              "companions-chip"
              + (providerId === connection.provider_id ? " companions-chip--active" : "")
            }
          >
            <input
              type="radio"
              name={`${namePrefix}-provider`}
              value={connection.provider_id}
              checked={providerId === connection.provider_id}
              disabled={disabled}
              onChange={() => onChange({
                providerId: connection.provider_id,
                modelId: providerDefaultModel(providers, connection.provider_id),
              })}
            />
            <span>{providerName(connection.provider_id)}</span>
            {providers.default_provider_id === connection.provider_id && <em>Default</em>}
          </label>
        ))}
      </fieldset>

      <fieldset
        className="companions-picker"
        disabled={disabled || !selectedProvider}
        aria-describedby={descriptionId}
      >
        <legend>2. Model</legend>
        {selectedProvider?.models.map((model) => (
          <label
            key={model.id}
            className={
              "companions-chip"
              + (modelId === model.id ? " companions-chip--active" : "")
            }
          >
            <input
              type="radio"
              name={`${namePrefix}-model`}
              value={model.id}
              checked={modelId === model.id}
              disabled={disabled || !selectedProvider}
              onChange={() => onChange({ providerId, modelId: model.id })}
            />
            <span>{model.name}</span>
            {model.default && <em>Default</em>}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
