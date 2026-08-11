package main

type credentialsFile struct {
	SchemaVersion     int                            `json:"schemaVersion"`
	ActiveWorkspaceID string                         `json:"activeWorkspaceId"`
	Workspaces        map[string]workspaceCredential `json:"workspaces"`
}

type workspaceCredential struct {
	APIURL string `json:"apiUrl"`
}

type gatewayConfig struct {
	ClientPath string            `json:"client_path,omitempty"`
	Aliases    map[string]string `json:"aliases,omitempty"`
	Tools      []string          `json:"tools,omitempty"`
}

type catalogSnapshot struct {
	SnapshotID  string           `json:"snapshot_id"`
	WorkspaceID string           `json:"workspace_id"`
	CreatedAt   string           `json:"created_at"`
	ExpiresAt   string           `json:"expires_at"`
	Packages    []catalogPackage `json:"packages"`
}

type catalogPackage struct {
	SkillID         string   `json:"skill_id"`
	VersionID       string   `json:"version_id"`
	Slug            string   `json:"slug"`
	Version         string   `json:"version"`
	Checksum        string   `json:"checksum"`
	SizeBytes       int64    `json:"size_bytes"`
	Frontmatter     string   `json:"frontmatter"`
	DependencySlugs []string `json:"dependency_slugs"`
	RootSlugs       []string `json:"root_slugs"`
	PackageURL      string   `json:"package_url"`
	APIOrigin       string   `json:"api_origin"`
	Proof           string   `json:"proof"`
	WorkspaceID     string   `json:"workspace_id,omitempty"`
	Alias           string   `json:"alias,omitempty"`
}

type mergedCatalog struct {
	GeneratedAt string           `json:"generated_at"`
	ExpiresAt   string           `json:"expires_at"`
	Packages    []catalogPackage `json:"packages"`
}

type proxyMarker struct {
	Managed     bool   `json:"managed_by_companion_gateway"`
	WorkspaceID string `json:"workspace_id"`
	Slug        string `json:"slug"`
	Alias       string `json:"alias"`
	Version     string `json:"version"`
}

type proxyRegistry struct {
	Paths map[string]proxyMarker `json:"paths"`
}
