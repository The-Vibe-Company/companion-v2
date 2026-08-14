"use client";

import type { CompanionProvidersResponse } from "@companion/contracts";

export function providerDefaultModel(
  providers: CompanionProvidersResponse,
  providerId: string,
): string {
  return providers.catalog
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => model.default)?.id ?? "";
}

export function CompanionProviderModelPicker({
  providers,
  providerId,
  modelId,
  namePrefix,
  disabled = false,
  onChange,
}: {
  providers: CompanionProvidersResponse;
  providerId: string;
  modelId: string;
  namePrefix: string;
  disabled?: boolean;
  onChange: (selection: { providerId: string; modelId: string }) => void;
}) {
  const providerName = (id: string) =>
    providers.catalog.find((provider) => provider.id === id)?.name ?? id;
  const selectedProvider = providers.catalog.find((provider) => provider.id === providerId);

  return (
    <div className="companions-provider-model-picker">
      <fieldset className="companions-picker" disabled={disabled}>
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

      <fieldset className="companions-picker" disabled={disabled || !selectedProvider}>
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
