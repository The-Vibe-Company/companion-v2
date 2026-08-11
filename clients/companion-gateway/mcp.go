package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func rpcWrite(value any) error {
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "%s\n", bytes)
	return err
}

func rpcResult(id json.RawMessage, result any) error {
	return rpcWrite(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func rpcError(id json.RawMessage, code int, message string) error {
	return rpcWrite(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": redact(message)}})
}

func mcpTools() []map[string]any {
	return []map[string]any{
		{
			"name":        "companion_catalog_sync",
			"description": "Refresh all connected Companion workspaces and native skill proxies.",
			"inputSchema": map[string]any{"type": "object", "additionalProperties": false},
		},
		{
			"name":        "companion_skill_resolve",
			"description": "Resolve an exact remote Companion skill and dependency closure into a temporary directory.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"workspace": map[string]any{"type": "string"},
					"skill":     map[string]any{"type": "string"},
				},
				"required":             []string{"workspace", "skill"},
				"additionalProperties": false,
			},
		},
	}
}

func serveMCP() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	for scanner.Scan() {
		var request rpcRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			_ = rpcError(nil, -32700, "invalid JSON-RPC request")
			continue
		}
		switch request.Method {
		case "initialize":
			_ = rpcResult(request.ID, map[string]any{
				"protocolVersion": "2025-03-26",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "companion-gateway", "version": gatewayVersion},
			})
		case "notifications/initialized":
			// Notification: deliberately no response.
		case "ping":
			_ = rpcResult(request.ID, map[string]any{})
		case "tools/list":
			_ = rpcResult(request.ID, map[string]any{"tools": mcpTools()})
		case "tools/call":
			var params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			if err := json.Unmarshal(request.Params, &params); err != nil {
				_ = rpcError(request.ID, -32602, "invalid tool arguments")
				continue
			}
			var result any
			var err error
			switch params.Name {
			case "companion_catalog_sync":
				result, err = syncCatalog()
			case "companion_skill_resolve":
				workspace, _ := params.Arguments["workspace"].(string)
				skill, _ := params.Arguments["skill"].(string)
				var root string
				root, _, _, err = loadState()
				if err == nil {
					var catalog mergedCatalog
					catalog, err = loadCatalog(root)
					if err == nil {
						result, err = resolveSkill(root, catalog, workspace, skill)
					}
				}
			default:
				err = fmt.Errorf("unknown tool %q", params.Name)
			}
			if err != nil {
				_ = rpcResult(request.ID, map[string]any{
					"content": []map[string]any{{"type": "text", "text": redact(err.Error())}},
					"isError": true,
				})
				continue
			}
			encoded, _ := json.Marshal(result)
			_ = rpcResult(request.ID, map[string]any{
				"content": []map[string]any{{"type": "text", "text": string(encoded)}},
			})
		default:
			_ = rpcError(request.ID, -32601, "method not found")
		}
	}
	return scanner.Err()
}
