package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func packageZIP(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, contents := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func catalogPackageForTest(slug, proof, packageURL string, archive []byte, roots []string) catalogPackage {
	digest := sha256.Sum256(archive)
	parsed, _ := url.Parse(packageURL)
	return catalogPackage{
		SkillID:     "skill-" + slug,
		VersionID:   "version-" + slug,
		Slug:        slug,
		Alias:       slug,
		Version:     "1.0.0",
		Checksum:    "sha256:" + hex.EncodeToString(digest[:]),
		SizeBytes:   int64(len(archive)),
		RootSlugs:   roots,
		PackageURL:  packageURL,
		APIOrigin:   (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host}).String(),
		Proof:       proof,
		WorkspaceID: "workspace-1",
	}
}

func TestResolveSkillDownloadsVerifiedRootAndDependency(t *testing.T) {
	rootArchive := packageZIP(t, map[string]string{
		"SKILL.md":       "# Root\n",
		"scripts/run.sh": "#!/bin/sh\n",
	})
	dependencyArchive := packageZIP(t, map[string]string{"SKILL.md": "# Dependency\n"})
	archives := map[string][]byte{"/v1/agent-catalog/packages/root/1.0.0": rootArchive, "/v1/agent-catalog/packages/dependency/1.0.0": dependencyArchive}
	proofs := map[string]string{"/v1/agent-catalog/packages/root/1.0.0": "proof-root", "/v1/agent-catalog/packages/dependency/1.0.0": "proof-dependency"}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		archive, found := archives[request.URL.Path]
		if !found {
			http.NotFound(response, request)
			return
		}
		if request.Header.Get("x-companion-catalog-proof") != proofs[request.URL.Path] {
			http.Error(response, "missing proof", http.StatusUnauthorized)
			return
		}
		response.Header().Set("Content-Length", stringValue(len(archive)))
		_, _ = response.Write(archive)
	}))
	defer server.Close()

	companionRoot := t.TempDir()
	catalog := mergedCatalog{Packages: []catalogPackage{
		catalogPackageForTest("root", "proof-root", server.URL+"/v1/agent-catalog/packages/root/1.0.0", rootArchive, []string{"root"}),
		catalogPackageForTest("dependency", "proof-dependency", server.URL+"/v1/agent-catalog/packages/dependency/1.0.0", dependencyArchive, []string{"root"}),
	}}
	result, err := resolveSkill(companionRoot, catalog, "workspace-1", "root")
	if err != nil {
		t.Fatal(err)
	}
	rootSkill, err := os.ReadFile(filepath.Join(result.Path, "SKILL.md"))
	if err != nil || string(rootSkill) != "# Root\n" {
		t.Fatalf("unexpected resolved root: %q, %v", rootSkill, err)
	}
	dependencyPath := result.Dependencies["dependency"]
	dependencySkill, err := os.ReadFile(filepath.Join(dependencyPath, "SKILL.md"))
	if err != nil || string(dependencySkill) != "# Dependency\n" {
		t.Fatalf("unexpected resolved dependency: %q, %v", dependencySkill, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(result.Path), ".companion-resolution.json")); err != nil {
		t.Fatalf("resolution manifest is missing: %v", err)
	}
}

func TestResolveSkillRejectsChangedPackageBytes(t *testing.T) {
	archive := packageZIP(t, map[string]string{"SKILL.md": "# Root\n"})
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte("changed"))
	}))
	defer server.Close()
	pkg := catalogPackageForTest("root", "proof", server.URL+"/v1/agent-catalog/packages/root/1.0.0", archive, []string{"root"})
	pkg.SizeBytes = int64(len("changed"))
	_, err := resolveSkill(t.TempDir(), mergedCatalog{Packages: []catalogPackage{pkg}}, "workspace-1", "root")
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("checksum mismatch")) {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
}

func TestFetchPackageRejectsURLOutsideWorkspaceOrigin(t *testing.T) {
	archive := packageZIP(t, map[string]string{"SKILL.md": "# Root\n"})
	pkg := catalogPackageForTest("root", "proof", "https://attacker.invalid/v1/agent-catalog/packages/root/1.0.0", archive, []string{"root"})
	pkg.APIOrigin = "https://companion.example"
	_, err := fetchPackage(pkg)
	if err == nil || !strings.Contains(err.Error(), "outside the configured workspace API origin") {
		t.Fatalf("expected cross-origin package URL rejection, got %v", err)
	}
}

func stringValue(value int) string {
	return fmt.Sprintf("%d", value)
}
