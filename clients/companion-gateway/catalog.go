package main

import (
	"fmt"
	"regexp"
	"sort"
	"time"
)

var skillNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func mergeSnapshots(snapshots []catalogSnapshot, aliases map[string]string) (mergedCatalog, error) {
	merged := mergedCatalog{GeneratedAt: time.Now().UTC().Format(time.RFC3339)}
	claimed := map[string]string{}
	var earliest time.Time
	for _, snapshot := range snapshots {
		expires, err := time.Parse(time.RFC3339, snapshot.ExpiresAt)
		if err != nil || !expires.After(time.Now()) {
			return merged, fmt.Errorf("workspace %s returned an expired or invalid snapshot", snapshot.WorkspaceID)
		}
		if earliest.IsZero() || expires.Before(earliest) {
			earliest = expires
		}
		for _, pkg := range snapshot.Packages {
			pkg.WorkspaceID = snapshot.WorkspaceID
			key := snapshot.WorkspaceID + "/" + pkg.Slug
			pkg.Alias = aliases[key]
			if pkg.Alias == "" {
				pkg.Alias = pkg.Slug
			}
			if !skillNamePattern.MatchString(pkg.Alias) {
				return merged, fmt.Errorf("invalid local alias %q for %s", pkg.Alias, key)
			}
			if isRootPackage(pkg) {
				if previous, exists := claimed[pkg.Alias]; exists && previous != key {
					return merged, fmt.Errorf("catalog alias collision %q between %s and %s; add an explicit gateway.json alias", pkg.Alias, previous, key)
				}
				claimed[pkg.Alias] = key
			}
			merged.Packages = append(merged.Packages, pkg)
		}
	}
	merged.ExpiresAt = earliest.UTC().Format(time.RFC3339)
	sort.Slice(merged.Packages, func(i, j int) bool {
		if merged.Packages[i].Alias == merged.Packages[j].Alias {
			return merged.Packages[i].WorkspaceID < merged.Packages[j].WorkspaceID
		}
		return merged.Packages[i].Alias < merged.Packages[j].Alias
	})
	return merged, nil
}

func isRootPackage(pkg catalogPackage) bool {
	for _, slug := range pkg.RootSlugs {
		if slug == pkg.Slug {
			return true
		}
	}
	return false
}

func findPackage(catalog mergedCatalog, workspaceID, slug string) (catalogPackage, bool) {
	for _, pkg := range catalog.Packages {
		if pkg.WorkspaceID == workspaceID && (pkg.Slug == slug || pkg.Alias == slug) {
			return pkg, true
		}
	}
	return catalogPackage{}, false
}
