# Claude Desktop Icon Badge Design

Claude Code and Claude Desktop keep the same Claude brand icon. Claude Desktop adds a small monitor badge at the lower-right corner; Claude Code remains unbadged. This preserves brand recognition while making the runtime entry point visible in dense project and session lists.

The badge is rendered by SessionBar CSS instead of loading an asset from `/Applications/Claude.app`, so the Web UI remains portable. It is decorative, while the image alt text and surrounding title continue to expose the full session type.

Provider icons remain separate: an Anthropic or Kimi provider association does not replace the session's runtime icon.
