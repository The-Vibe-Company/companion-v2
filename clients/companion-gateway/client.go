package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func resolveClient(root string, config gatewayConfig) (string, error) {
	candidates := []string{config.ClientPath, os.Getenv("COMPANION_AGENT_CLIENT")}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		absolute, err := filepath.Abs(candidate)
		if err == nil {
			if info, statErr := os.Stat(absolute); statErr == nil && info.Mode().IsRegular() {
				return absolute, nil
			}
		}
	}
	return "", fmt.Errorf("Companion Agent Auth client not found; set gateway.json client_path or COMPANION_AGENT_CLIENT")
}

func requestSnapshot(clientPath, workspaceID string) (catalogSnapshot, error) {
	request := map[string]any{
		"action":      "api",
		"workspaceId": workspaceID,
		"method":      "POST",
		"path":        "/agent-catalog/snapshots",
		"body":        map[string]any{},
	}
	input, _ := json.Marshal(request)
	command := exec.Command("node", clientPath)
	command.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return catalogSnapshot{}, fmt.Errorf("snapshot %s failed: %w: %s", workspaceID, err, redact(stderr.String()))
	}
	var snapshot catalogSnapshot
	if err := json.Unmarshal(stdout.Bytes(), &snapshot); err != nil {
		return snapshot, fmt.Errorf("snapshot %s returned invalid JSON: %w", workspaceID, err)
	}
	if snapshot.WorkspaceID != workspaceID {
		return snapshot, fmt.Errorf("snapshot workspace mismatch: requested %s, received %s", workspaceID, snapshot.WorkspaceID)
	}
	return snapshot, nil
}

func redact(value string) string {
	// Keep diagnostics useful without reproducing any Companion bearer material.
	for _, prefix := range []string{"cmp_pat_", "cmp_grant_", "cmp_xfer_", "cmp_catalog_v1."} {
		for {
			start := bytes.Index([]byte(value), []byte(prefix))
			if start < 0 {
				break
			}
			end := start
			for end < len(value) && value[end] > ' ' && value[end] != '"' && value[end] != '\'' {
				end++
			}
			value = value[:start] + "[REDACTED]" + value[end:]
		}
	}
	return value
}
