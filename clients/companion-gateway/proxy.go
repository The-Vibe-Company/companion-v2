package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const markerName = ".companion-proxy.json"

func toolRoots(home string, tools []string) ([]string, error) {
	roots := make([]string, 0, len(tools))
	seen := map[string]bool{}
	for _, tool := range tools {
		var root string
		switch tool {
		case "claude-code":
			root = filepath.Join(home, ".claude", "skills")
		case "codex":
			root = filepath.Join(home, ".agents", "skills")
		default:
			return nil, fmt.Errorf("unsupported gateway tool %q", tool)
		}
		if !seen[root] {
			seen[root] = true
			roots = append(roots, root)
		}
	}
	return roots, nil
}

func proxyMarkdown(pkg catalogPackage) string {
	dependencies := "none"
	if len(pkg.DependencySlugs) > 0 {
		dependencies = strings.Join(pkg.DependencySlugs, ", ")
	}
	return fmt.Sprintf(`---
name: %s
description: Resolve and use the remote Companion skill %s from workspace %s on demand.
---

# Remote Companion skill: %s

This is a metadata-only proxy. The real package is not installed on this machine.

Before following this skill, run:

    companion-gateway resolve --workspace %s --skill %s

Open the returned temporary directory's SKILL.md and follow it as the authoritative instructions.
Resolve the package again if the snapshot has expired. Do not substitute another workspace or version.

Pinned version: %s. Dependencies resolved with the same snapshot: %s.
`, pkg.Alias, pkg.Slug, pkg.WorkspaceID, pkg.Alias, pkg.WorkspaceID, pkg.Slug, pkg.Version, dependencies)
}

func managedMarker(path string) (proxyMarker, bool, error) {
	var marker proxyMarker
	err := readJSON(filepath.Join(path, markerName), &marker)
	if errors.Is(err, os.ErrNotExist) {
		return marker, false, nil
	}
	if err != nil {
		return marker, false, err
	}
	return marker, marker.Managed, nil
}

func writeProxy(destination string, pkg catalogPackage, owned *proxyMarker) error {
	root := filepath.Dir(destination)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	if info, err := os.Lstat(destination); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("refusing to overwrite unmanaged proxy destination: %s", destination)
		}
		marker, managed, markerErr := managedMarker(destination)
		desired := proxyMarker{Managed: true, WorkspaceID: pkg.WorkspaceID, Slug: pkg.Slug, Alias: pkg.Alias, Version: pkg.Version}
		if markerErr != nil || !managed || owned == nil || (marker != *owned && marker != desired) {
			return fmt.Errorf("refusing to overwrite unmanaged skill directory: %s", destination)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	stage, err := os.MkdirTemp(root, ".companion-proxy-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := os.WriteFile(filepath.Join(stage, "SKILL.md"), []byte(proxyMarkdown(pkg)), 0o644); err != nil {
		return err
	}
	marker := proxyMarker{Managed: true, WorkspaceID: pkg.WorkspaceID, Slug: pkg.Slug, Alias: pkg.Alias, Version: pkg.Version}
	markerBytes, _ := json.MarshalIndent(marker, "", "  ")
	if err := os.WriteFile(filepath.Join(stage, markerName), append(markerBytes, '\n'), 0o644); err != nil {
		return err
	}
	backup := destination + ".companion-old"
	if _, err := os.Stat(backup); err == nil {
		return fmt.Errorf("stale proxy backup requires inspection: %s", backup)
	}
	if _, err := os.Stat(destination); err == nil {
		if err := os.Rename(destination, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(stage, destination); err != nil {
		if _, backupErr := os.Stat(backup); backupErr == nil {
			_ = os.Rename(backup, destination)
		}
		return err
	}
	if _, err := os.Stat(backup); err == nil {
		if err := os.RemoveAll(backup); err != nil {
			return err
		}
	}
	return nil
}

type proxyWrite struct {
	Destination string
	Package     catalogPackage
	Owned       *proxyMarker
}

type proxySyncPlan struct {
	CompanionRoot string
	Writes        []proxyWrite
	Removals      []string
	Registry      proxyRegistry
}

func proxyRegistryPath(companionRoot string) string {
	return filepath.Join(companionRoot, "gateway", "proxies.json")
}

func markerForPackage(pkg catalogPackage) proxyMarker {
	return proxyMarker{Managed: true, WorkspaceID: pkg.WorkspaceID, Slug: pkg.Slug, Alias: pkg.Alias, Version: pkg.Version}
}

func directChildOf(path string, roots []string) bool {
	clean := filepath.Clean(path)
	for _, root := range roots {
		if filepath.Dir(clean) == filepath.Clean(root) && filepath.Base(clean) != "." {
			return true
		}
	}
	return false
}

func preflightProxySync(companionRoot string, catalog mergedCatalog, tools []string) (proxySyncPlan, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return proxySyncPlan{}, err
	}
	roots, err := toolRoots(home, tools)
	if err != nil {
		return proxySyncPlan{}, err
	}
	allRoots, err := toolRoots(home, []string{"claude-code", "codex"})
	if err != nil {
		return proxySyncPlan{}, err
	}
	registry := proxyRegistry{Paths: map[string]proxyMarker{}}
	if err := readJSON(proxyRegistryPath(companionRoot), &registry); err != nil && !errors.Is(err, os.ErrNotExist) {
		return proxySyncPlan{}, fmt.Errorf("read proxy ownership registry: %w", err)
	}
	if registry.Paths == nil {
		registry.Paths = map[string]proxyMarker{}
	}
	desired := map[string]catalogPackage{}
	for _, pkg := range catalog.Packages {
		if isRootPackage(pkg) {
			for _, root := range roots {
				desired[filepath.Clean(filepath.Join(root, pkg.Alias))] = pkg
			}
		}
	}
	paths := make([]string, 0, len(desired))
	for path := range desired {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	plan := proxySyncPlan{CompanionRoot: companionRoot, Registry: proxyRegistry{Paths: map[string]proxyMarker{}}}
	for _, destination := range paths {
		pkg := desired[destination]
		desiredMarker := markerForPackage(pkg)
		ownedMarker, registered := registry.Paths[destination]
		if info, statErr := os.Lstat(destination); statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return proxySyncPlan{}, fmt.Errorf("unmanaged destination blocks proxy sync: %s", destination)
			}
			marker, managed, markerErr := managedMarker(destination)
			if markerErr != nil || !managed || !registered || (marker != ownedMarker && marker != desiredMarker) {
				return proxySyncPlan{}, fmt.Errorf("unmanaged skill blocks proxy sync: %s", destination)
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return proxySyncPlan{}, statErr
		}
		var owned *proxyMarker
		if registered {
			copy := ownedMarker
			owned = &copy
		}
		plan.Writes = append(plan.Writes, proxyWrite{Destination: destination, Package: pkg, Owned: owned})
		plan.Registry.Paths[destination] = desiredMarker
	}
	registeredPaths := make([]string, 0, len(registry.Paths))
	for path := range registry.Paths {
		registeredPaths = append(registeredPaths, path)
	}
	sort.Strings(registeredPaths)
	for _, path := range registeredPaths {
		if _, stillDesired := desired[path]; stillDesired {
			continue
		}
		if !directChildOf(path, allRoots) {
			return proxySyncPlan{}, fmt.Errorf("proxy registry path is outside supported tool roots: %s", path)
		}
		info, statErr := os.Lstat(path)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return proxySyncPlan{}, fmt.Errorf("registered proxy requires inspection: %s", path)
		}
		marker, managed, markerErr := managedMarker(path)
		if markerErr != nil || !managed || marker != registry.Paths[path] {
			return proxySyncPlan{}, fmt.Errorf("registered proxy ownership changed: %s", path)
		}
		plan.Removals = append(plan.Removals, path)
	}
	return plan, nil
}

func applyProxySync(plan proxySyncPlan) error {
	for _, write := range plan.Writes {
		if err := writeProxy(write.Destination, write.Package, write.Owned); err != nil {
			return err
		}
	}
	for _, path := range plan.Removals {
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return atomicPrivateJSON(proxyRegistryPath(plan.CompanionRoot), plan.Registry)
}

func syncProxies(companionRoot string, catalog mergedCatalog, tools []string) error {
	plan, err := preflightProxySync(companionRoot, catalog, tools)
	if err != nil {
		return err
	}
	return applyProxySync(plan)
}
