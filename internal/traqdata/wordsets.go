package traqdata

var channelWordsets = map[Wordset][][]string{
	PublicWordset: {
		{"team", "project", "club", "lab", "class", "event", "help", "bot", "game", "music", "art", "book", "photo", "video", "news", "data", "infra", "design", "staff", "admin", "sales", "ops", "home", "work"},
		{"core", "dev", "web", "app", "api", "mobile", "server", "client", "data", "search", "auth", "chat", "voice", "image", "build", "test", "docs", "plan", "meet", "room", "topic", "note", "task", "release", "support", "random", "social", "media", "study", "learn", "write", "read"},
		{"main", "alpha", "beta", "green", "blue", "red", "gold", "fast", "slow", "daily", "weekly", "night", "idea", "bug", "fix", "review", "deploy", "log", "alert", "queue", "cache", "store", "index", "job", "skill", "tool", "link", "feed", "draft", "memo", "board", "map"},
		{"open", "close", "new", "old", "hot", "cold", "north", "south", "east", "west", "local", "global", "public", "private", "small", "large", "light", "dark", "early", "late", "first", "last", "next", "back", "front", "inner", "outer", "quiet", "active", "ready", "live", "safe"},
		{"inbox", "outbox", "todo", "done", "wait", "hold", "sync", "async", "push", "pull", "send", "recv", "read", "write", "edit", "view", "watch", "build", "ship", "run", "test", "check", "note", "memo", "list", "grid", "feed", "chat", "voice", "call", "desk", "room"},
	},
	PrivateWordset: {
		{"circle", "square", "river", "mountain", "forest", "ocean", "garden", "bridge", "castle", "market", "station", "kitchen", "library", "museum", "theater", "hospital", "airport", "factory", "office", "school", "temple", "harbor", "village", "planet"},
		{"engine", "window", "button", "canvas", "column", "cursor", "dialog", "filter", "header", "layout", "module", "packet", "parser", "query", "router", "schema", "socket", "stream", "table", "token", "widget", "worker", "archive", "branch", "commit", "console", "kernel", "memory", "network", "portal", "script", "signal"},
		{"amber", "bronze", "coral", "silver", "violet", "yellow", "rapid", "gentle", "hourly", "monthly", "morning", "sunset", "concept", "issue", "patch", "audit", "launch", "trace", "notice", "stack", "buffer", "vault", "catalog", "process", "talent", "device", "route", "digest", "sketch", "record", "panel", "chart"},
		{"above", "below", "fresh", "ancient", "warm", "cool", "upward", "downward", "leftward", "rightward", "nearby", "remote", "shared", "hidden", "narrow", "broad", "bright", "shadow", "sooner", "later", "primary", "final", "forward", "inward", "outward", "silent", "busy", "stable", "online", "secure", "vacant", "pending"},
		{"entry", "exit", "begin", "finish", "pause", "resume", "upload", "download", "import", "export", "accept", "reject", "create", "remove", "update", "browse", "follow", "compile", "deliver", "execute", "verify", "message", "report", "folder", "screen", "terminal", "calendar", "contact", "account", "profile", "status", "summary"},
	},
}
