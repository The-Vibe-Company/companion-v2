package main

import (
	"strings"
	"testing"
	"time"
)

func future() string { return time.Now().Add(time.Hour).UTC().Format(time.RFC3339) }

func TestMergeSnapshotsBlocksUnaliasedCollisions(t *testing.T) {
	snapshots := []catalogSnapshot{
		{WorkspaceID: "one", ExpiresAt: future(), Packages: []catalogPackage{{Slug: "deploy", RootSlugs: []string{"deploy"}}}},
		{WorkspaceID: "two", ExpiresAt: future(), Packages: []catalogPackage{{Slug: "deploy", RootSlugs: []string{"deploy"}}}},
	}
	if _, err := mergeSnapshots(snapshots, nil); err == nil || !strings.Contains(err.Error(), "collision") {
		t.Fatalf("expected collision, got %v", err)
	}
	merged, err := mergeSnapshots(snapshots, map[string]string{"two/deploy": "deploy-two"})
	if err != nil {
		t.Fatal(err)
	}
	if merged.Packages[1].Alias != "deploy-two" {
		t.Fatalf("expected explicit alias, got %#v", merged.Packages)
	}
}

func TestDependencyPackagesDoNotClaimNativeAliases(t *testing.T) {
	snapshots := []catalogSnapshot{{
		WorkspaceID: "one",
		ExpiresAt:   future(),
		Packages: []catalogPackage{
			{Slug: "root", RootSlugs: []string{"root"}},
			{Slug: "shared", RootSlugs: []string{"root"}},
		},
	}}
	if _, err := mergeSnapshots(snapshots, nil); err != nil {
		t.Fatal(err)
	}
}

func TestSafeArchivePathRejectsWindowsAndTraversalNames(t *testing.T) {
	for _, path := range []string{"../escape", `dir\\escape`, "CON", "folder/aux.txt", "trailing. ", "/absolute"} {
		if _, _, err := safeArchivePath(path, map[string]bool{}); err == nil {
			t.Errorf("expected %q to be rejected", path)
		}
	}
	seen := map[string]bool{}
	if _, _, err := safeArchivePath("Skill.md", seen); err != nil {
		t.Fatal(err)
	}
	if _, _, err := safeArchivePath("skill.md", seen); err == nil {
		t.Fatal("expected case-insensitive collision")
	}
}
