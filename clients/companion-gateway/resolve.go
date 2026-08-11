package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const maxExpandedPackage = int64(128 * 1024 * 1024)
const maxPackageEntry = int64(64 * 1024 * 1024)
const maxPackageEntries = 4096

var windowsDeviceName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$`)

func loadCatalog(root string) (mergedCatalog, error) {
	var catalog mergedCatalog
	if err := readJSON(cachePath(root), &catalog); err != nil {
		return catalog, fmt.Errorf("read gateway catalog; run companion-gateway sync first: %w", err)
	}
	expires, err := time.Parse(time.RFC3339, catalog.ExpiresAt)
	if err != nil || !expires.After(time.Now()) {
		return catalog, errors.New("gateway catalog snapshot expired; reconnect and sync before resolving")
	}
	return catalog, nil
}

func runtimeRoot(companionRoot string) string {
	digest := sha256.Sum256([]byte(companionRoot))
	return filepath.Join(os.TempDir(), "companion-gateway-"+hex.EncodeToString(digest[:6]))
}

func cleanupStaleRuntime(companionRoot string, now time.Time) error {
	root := runtimeRoot(companionRoot)
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "session-") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		info, statErr := entry.Info()
		if statErr == nil && now.Sub(info.ModTime()) > 24*time.Hour {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
		}
	}
	return nil
}

func fetchPackage(pkg catalogPackage) ([]byte, error) {
	if err := validatePackageURL(pkg.PackageURL, pkg.APIOrigin); err != nil {
		return nil, fmt.Errorf("package %s URL rejected: %w", pkg.Slug, err)
	}
	request, err := http.NewRequest(http.MethodGet, pkg.PackageURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-companion-catalog-proof", pkg.Proof)
	client := &http.Client{
		Timeout:       2 * time.Minute,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		limited, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("package %s download failed (%d): %s", pkg.Slug, response.StatusCode, redact(string(limited)))
	}
	if response.ContentLength >= 0 && response.ContentLength != pkg.SizeBytes {
		return nil, fmt.Errorf("package %s size changed", pkg.Slug)
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, pkg.SizeBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(bytes)) != pkg.SizeBytes {
		return nil, fmt.Errorf("package %s size mismatch", pkg.Slug)
	}
	digest := sha256.Sum256(bytes)
	if "sha256:"+hex.EncodeToString(digest[:]) != pkg.Checksum {
		return nil, fmt.Errorf("package %s checksum mismatch", pkg.Slug)
	}
	return bytes, nil
}

func canonicalAPIOrigin(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("API URL must be an HTTP(S) origin without credentials")
	}
	return (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host}).String(), nil
}

func validatePackageURL(raw, expectedOrigin string) error {
	expected, err := canonicalAPIOrigin(expectedOrigin)
	if err != nil {
		return fmt.Errorf("invalid configured API origin: %w", err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	actual, err := canonicalAPIOrigin(raw)
	if err != nil {
		return err
	}
	if actual != expected || parsed.Fragment != "" {
		return errors.New("package URL is outside the configured workspace API origin")
	}
	if !strings.HasPrefix(parsed.EscapedPath(), "/v1/agent-catalog/packages/") {
		return errors.New("package URL is not a Companion catalog package endpoint")
	}
	return nil
}

func safeArchivePath(name string, seen map[string]bool) (string, bool, error) {
	if name == "" || strings.ContainsRune(name, 0) || strings.Contains(name, `\`) || strings.HasPrefix(name, "/") {
		return "", false, fmt.Errorf("unsafe ZIP path %q", name)
	}
	directory := strings.HasSuffix(name, "/")
	cleaned := strings.TrimSuffix(name, "/")
	parts := strings.Split(cleaned, "/")
	if cleaned == "" || len(parts) == 0 {
		return "", false, fmt.Errorf("unsafe ZIP path %q", name)
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, " ") || strings.HasSuffix(part, ".") || windowsDeviceName.MatchString(part) {
			return "", false, fmt.Errorf("unsafe cross-platform ZIP path %q", name)
		}
		for _, char := range part {
			if char <= 31 || strings.ContainsRune(`<>:"|?*`, char) {
				return "", false, fmt.Errorf("unsafe cross-platform ZIP path %q", name)
			}
		}
	}
	key := strings.ToLower(cleaned)
	if seen[key] {
		return "", false, fmt.Errorf("duplicate or case-colliding ZIP path %q", name)
	}
	seen[key] = true
	return filepath.FromSlash(cleaned), directory, nil
}

func extractPackage(archive []byte, destination string) error {
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return err
	}
	if len(reader.File) > maxPackageEntries {
		return errors.New("ZIP exceeds entry-count limit")
	}
	seen := map[string]bool{}
	var expanded int64
	for _, entry := range reader.File {
		relative, directory, err := safeArchivePath(entry.Name, seen)
		if err != nil {
			return err
		}
		if entry.Mode()&os.ModeSymlink != 0 || (!directory && !entry.Mode().IsRegular()) {
			return fmt.Errorf("ZIP links and special files are not allowed: %s", entry.Name)
		}
		if int64(entry.UncompressedSize64) > maxPackageEntry {
			return fmt.Errorf("ZIP entry exceeds size limit: %s", entry.Name)
		}
		expanded += int64(entry.UncompressedSize64)
		if expanded > maxExpandedPackage {
			return errors.New("ZIP exceeds expanded-size limit")
		}
		target := filepath.Join(destination, relative)
		if directory {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		input, err := entry.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			input.Close()
			return err
		}
		_, copyErr := io.Copy(output, io.LimitReader(input, maxPackageEntry+1))
		closeErr := output.Close()
		input.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if _, err := os.Stat(filepath.Join(destination, "SKILL.md")); err != nil {
		return errors.New("resolved package has no root SKILL.md")
	}
	return nil
}

type resolveResult struct {
	Path         string            `json:"path"`
	WorkspaceID  string            `json:"workspace_id"`
	Slug         string            `json:"slug"`
	Version      string            `json:"version"`
	Dependencies map[string]string `json:"dependencies"`
}

func resolveSkill(root string, catalog mergedCatalog, workspaceID, slug string) (resolveResult, error) {
	pkg, found := findPackage(catalog, workspaceID, slug)
	if !found || !isRootPackage(pkg) {
		return resolveResult{}, fmt.Errorf("remote catalog root not found: %s/%s", workspaceID, slug)
	}
	if err := cleanupStaleRuntime(root, time.Now()); err != nil {
		return resolveResult{}, err
	}
	runtime := runtimeRoot(root)
	if err := privateDir(runtime); err != nil {
		return resolveResult{}, err
	}
	session, err := os.MkdirTemp(runtime, "session-")
	if err != nil {
		return resolveResult{}, err
	}
	failed := true
	defer func() {
		if failed {
			_ = os.RemoveAll(session)
		}
	}()
	result := resolveResult{WorkspaceID: workspaceID, Slug: pkg.Slug, Version: pkg.Version, Dependencies: map[string]string{}}
	for _, candidate := range catalog.Packages {
		if candidate.WorkspaceID != workspaceID || !contains(candidate.RootSlugs, pkg.Slug) {
			continue
		}
		bytes, err := fetchPackage(candidate)
		if err != nil {
			return result, err
		}
		destination := filepath.Join(session, candidate.Slug)
		if err := os.Mkdir(destination, 0o700); err != nil {
			return result, err
		}
		if err := extractPackage(bytes, destination); err != nil {
			return result, fmt.Errorf("extract %s: %w", candidate.Slug, err)
		}
		if candidate.SkillID == pkg.SkillID {
			result.Path = destination
		} else {
			result.Dependencies[candidate.Slug] = destination
		}
	}
	if result.Path == "" {
		return result, errors.New("snapshot did not contain the root package")
	}
	manifest, _ := json.MarshalIndent(result, "", "  ")
	if err := os.WriteFile(filepath.Join(session, ".companion-resolution.json"), append(manifest, '\n'), 0o600); err != nil {
		return result, err
	}
	failed = false
	return result, nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
