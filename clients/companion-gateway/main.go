package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const gatewayVersion = "0.1.0"

type syncResult struct {
	Workspaces int      `json:"workspaces"`
	Skills     int      `json:"skills"`
	ExpiresAt  string   `json:"expires_at"`
	Tools      []string `json:"tools"`
}

func syncCatalog() (syncResult, error) {
	root, credentials, config, err := loadState()
	if err != nil {
		return syncResult{}, err
	}
	client, err := resolveClient(root, config)
	if err != nil {
		return syncResult{}, err
	}
	ids := workspaceIDs(credentials)
	snapshots := make([]catalogSnapshot, 0, len(ids))
	for _, id := range ids {
		snapshot, err := requestSnapshot(client, id)
		if err != nil {
			return syncResult{}, err
		}
		origin, err := canonicalAPIOrigin(credentials.Workspaces[id].APIURL)
		if err != nil {
			return syncResult{}, fmt.Errorf("workspace %s API URL: %w", id, err)
		}
		for index := range snapshot.Packages {
			snapshot.Packages[index].APIOrigin = origin
		}
		snapshots = append(snapshots, snapshot)
	}
	catalog, err := mergeSnapshots(snapshots, config.Aliases)
	if err != nil {
		return syncResult{}, err
	}
	proxyPlan, err := preflightProxySync(root, catalog, config.Tools)
	if err != nil {
		return syncResult{}, err
	}
	if err := atomicPrivateJSON(cachePath(root), catalog); err != nil {
		return syncResult{}, err
	}
	// Publish the catalog before its proxies. If a filesystem write fails midway, every old or new
	// proxy still resolves against a cache containing the complete new snapshot.
	if err := applyProxySync(proxyPlan); err != nil {
		return syncResult{}, err
	}
	if err := cleanupStaleRuntime(root, time.Now()); err != nil {
		return syncResult{}, err
	}
	roots := 0
	for _, pkg := range catalog.Packages {
		if isRootPackage(pkg) {
			roots++
		}
	}
	return syncResult{Workspaces: len(ids), Skills: roots, ExpiresAt: catalog.ExpiresAt, Tools: config.Tools}, nil
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func runResolved(args []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	workspace := flags.String("workspace", "", "connected workspace id")
	skill := flags.String("skill", "", "remote skill slug or local alias")
	envFile := flags.String("env-file", "", "read KEY=VALUE entries into process memory")
	legacyEnvFile := flags.String("legacy-env-file", "", "explicitly copy a temporary .env fallback into the resolved package")
	if err := flags.Parse(args); err != nil {
		return err
	}
	commandArgs := flags.Args()
	if *workspace == "" || *skill == "" || len(commandArgs) == 0 {
		return fmt.Errorf("run requires --workspace, --skill, and a command after --")
	}
	if *envFile != "" && *legacyEnvFile != "" {
		return fmt.Errorf("--env-file and --legacy-env-file are mutually exclusive")
	}
	root, _, _, err := loadState()
	if err != nil {
		return err
	}
	catalog, err := loadCatalog(root)
	if err != nil {
		return err
	}
	resolved, err := resolveSkill(root, catalog, *workspace, *skill)
	if err != nil {
		return err
	}
	environment := os.Environ()
	if *envFile != "" {
		values, err := dotenvValues(*envFile)
		if err != nil {
			return err
		}
		for key, value := range values {
			environment = append(environment, key+"="+value)
		}
	}
	var temporaryDotEnv string
	if *legacyEnvFile != "" {
		bytes, err := os.ReadFile(*legacyEnvFile)
		if err != nil {
			return err
		}
		temporaryDotEnv = filepath.Join(resolved.Path, ".env")
		if err := os.WriteFile(temporaryDotEnv, bytes, 0o600); err != nil {
			return err
		}
		defer os.Remove(temporaryDotEnv)
	}
	dependencies, _ := json.Marshal(resolved.Dependencies)
	environment = append(environment,
		"COMPANION_SKILL_ROOT="+resolved.Path,
		"COMPANION_SKILL_DEPENDENCIES="+string(dependencies),
	)
	command := exec.Command(commandArgs[0], commandArgs[1:]...)
	command.Dir = resolved.Path
	command.Env = environment
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}

func dotenvValues(path string) (map[string]string, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for number, raw := range strings.Split(string(bytes), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		if !found || key == "" || strings.ContainsAny(key, " \t\x00") {
			return nil, fmt.Errorf("invalid env entry at line %d", number+1)
		}
		values[key] = strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return values, nil
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: companion-gateway <sync|resolve|run|mcp|status|version>")
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "sync":
		var result syncResult
		result, err = syncCatalog()
		if err == nil {
			err = printJSON(result)
		}
	case "resolve":
		flags := flag.NewFlagSet("resolve", flag.ContinueOnError)
		workspace := flags.String("workspace", "", "connected workspace id")
		skill := flags.String("skill", "", "remote skill slug or local alias")
		jsonOutput := flags.Bool("json", false, "print the full resolution result")
		err = flags.Parse(os.Args[2:])
		if err == nil && (*workspace == "" || *skill == "") {
			err = fmt.Errorf("resolve requires --workspace and --skill")
		}
		if err == nil {
			var root string
			root, _, _, err = loadState()
			if err == nil {
				var catalog mergedCatalog
				catalog, err = loadCatalog(root)
				if err == nil {
					var result resolveResult
					result, err = resolveSkill(root, catalog, *workspace, *skill)
					if err == nil {
						if *jsonOutput {
							err = printJSON(result)
						} else {
							fmt.Fprintln(os.Stdout, result.Path)
						}
					}
				}
			}
		}
	case "run":
		err = runResolved(os.Args[2:])
	case "mcp":
		err = serveMCP()
	case "status":
		var root string
		root, _, _, err = loadState()
		if err == nil {
			var catalog mergedCatalog
			catalog, err = loadCatalog(root)
			if err == nil {
				roots := []string{}
				for _, pkg := range catalog.Packages {
					if isRootPackage(pkg) {
						roots = append(roots, pkg.WorkspaceID+"/"+pkg.Alias)
					}
				}
				sort.Strings(roots)
				err = printJSON(map[string]any{"expires_at": catalog.ExpiresAt, "skills": roots})
			}
		}
	case "version":
		fmt.Fprintln(os.Stdout, gatewayVersion)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, redact(err.Error()))
		os.Exit(1)
	}
}
