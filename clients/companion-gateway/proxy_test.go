package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setTestHome(t *testing.T, home string) {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
}

func TestSyncProxiesWritesMetadataOnlyNativeSkills(t *testing.T) {
	home := t.TempDir()
	setTestHome(t, home)
	companionRoot := filepath.Join(home, ".companion")
	catalog := mergedCatalog{Packages: []catalogPackage{{
		WorkspaceID:     "workspace-1",
		SkillID:         "skill-1",
		Slug:            "deploy",
		Alias:           "deploy-acme",
		Version:         "1.2.3",
		RootSlugs:       []string{"deploy"},
		DependencySlugs: []string{"shared"},
	}}}
	if err := syncProxies(companionRoot, catalog, []string{"claude-code", "codex"}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(home, ".claude", "skills", "deploy-acme", "SKILL.md"),
		filepath.Join(home, ".agents", "skills", "deploy-acme", "SKILL.md"),
	} {
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(contents)
		if !strings.Contains(text, "metadata-only proxy") || strings.Contains(text, "real package contents") {
			t.Fatalf("unexpected proxy at %s: %s", path, text)
		}
	}
}

func TestSyncProxiesRefusesUnmanagedNativeSkill(t *testing.T) {
	home := t.TempDir()
	setTestHome(t, home)
	companionRoot := filepath.Join(home, ".companion")
	unmanaged := filepath.Join(home, ".claude", "skills", "deploy")
	if err := os.MkdirAll(unmanaged, 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte("# Physical skill\n")
	if err := os.WriteFile(filepath.Join(unmanaged, "SKILL.md"), original, 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := mergedCatalog{Packages: []catalogPackage{{
		WorkspaceID: "workspace-1",
		SkillID:     "skill-1",
		Slug:        "deploy",
		Alias:       "deploy",
		Version:     "1.0.0",
		RootSlugs:   []string{"deploy"},
	}}}
	if err := syncProxies(companionRoot, catalog, []string{"claude-code"}); err == nil || !strings.Contains(err.Error(), "unmanaged skill") {
		t.Fatalf("expected unmanaged collision, got %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(unmanaged, "SKILL.md"))
	if err != nil || string(contents) != string(original) {
		t.Fatalf("unmanaged skill was changed: %q, %v", contents, err)
	}
}

func TestSyncProxiesDoesNotTrustAForgedMarker(t *testing.T) {
	home := t.TempDir()
	setTestHome(t, home)
	destination := filepath.Join(home, ".claude", "skills", "deploy")
	if err := os.MkdirAll(destination, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := []byte(`{"managed_by_companion_gateway":true,"workspace_id":"workspace-1","slug":"deploy","alias":"deploy","version":"1.0.0"}`)
	if err := os.WriteFile(filepath.Join(destination, markerName), marker, 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := mergedCatalog{Packages: []catalogPackage{{
		WorkspaceID: "workspace-1", Slug: "deploy", Alias: "deploy", Version: "1.0.0", RootSlugs: []string{"deploy"},
	}}}
	err := syncProxies(filepath.Join(home, ".companion"), catalog, []string{"claude-code"})
	if err == nil || !strings.Contains(err.Error(), "unmanaged skill") {
		t.Fatalf("expected an unregistered marker to be rejected, got %v", err)
	}
}
