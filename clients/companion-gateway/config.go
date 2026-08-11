package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

func companionHome() (string, error) {
	if value := os.Getenv("COMPANION_HOME"); value != "" {
		return filepath.Abs(value)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".companion"), nil
}

func privateDir(path string) error {
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing symlinked state directory: %s", path)
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func readJSON(path string, target any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("refusing non-regular JSON file: %s", path)
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes, target)
}

func atomicPrivateJSON(path string, value any) error {
	if err := privateDir(filepath.Dir(path)); err != nil {
		return err
	}
	bytes, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	bytes = append(bytes, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".gateway-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(bytes); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func loadState() (string, credentialsFile, gatewayConfig, error) {
	root, err := companionHome()
	if err != nil {
		return "", credentialsFile{}, gatewayConfig{}, err
	}
	var credentials credentialsFile
	if err := readJSON(filepath.Join(root, "credentials.json"), &credentials); err != nil {
		return "", credentials, gatewayConfig{}, fmt.Errorf("read connected workspaces: %w", err)
	}
	if credentials.SchemaVersion != 3 || len(credentials.Workspaces) == 0 {
		return "", credentials, gatewayConfig{}, errors.New("Companion credentials schema v3 has no connected workspace")
	}
	config := gatewayConfig{Aliases: map[string]string{}, Tools: []string{"claude-code", "codex"}}
	configPath := filepath.Join(root, "gateway.json")
	if err := readJSON(configPath, &config); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", credentials, config, fmt.Errorf("read gateway config: %w", err)
	}
	if config.Aliases == nil {
		config.Aliases = map[string]string{}
	}
	if len(config.Tools) == 0 {
		config.Tools = []string{"claude-code", "codex"}
	}
	return root, credentials, config, nil
}

func workspaceIDs(credentials credentialsFile) []string {
	ids := make([]string, 0, len(credentials.Workspaces))
	for id, workspace := range credentials.Workspaces {
		if id != "" && workspace.APIURL != "" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func cachePath(root string) string { return filepath.Join(root, "gateway", "catalog.json") }
