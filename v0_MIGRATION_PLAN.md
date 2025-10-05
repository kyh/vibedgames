# Migration Plan: From v0 to Coding Agent System

## Overview

This document outlines the comprehensive plan to migrate the `nextjs` app from using v0's backend service to a self-hosted coding agent system based on the `template-coding-agent` implementation.

## Current State Analysis

### Current v0 System

- **Frontend**: Uses `@v0-sdk/react` for streaming responses
- **Backend**: Relies on v0's external service for game generation
- **Interface**: Simple chat-based UI with streaming messages
- **Persistence**: No local task management or database persistence
- **Dependencies**: `@v0-sdk/react`, basic Next.js setup

### Target Coding Agent System

- **Frontend**: Additional task management UI alongside existing v0 interface
- **Backend**: Self-hosted Claude agent with sandbox execution via TRPC endpoints
- **Interface**: New task-based workflow pages + existing v0 chat interface
- **Persistence**: PostgreSQL database with Drizzle ORM in `packages/db`
- **API Layer**: TRPC routers in `packages/api` + existing v0 API routes
- **Dependencies**: Claude SDK, Vercel Sandbox, database tools

## Key Benefits of Migration

1. **Self-hosted control**: No dependency on v0's backend
2. **Claude agent**: Powerful AI agent for code generation
3. **Isolated execution**: Safe code execution in Vercel Sandboxes
4. **Persistent tasks**: Track and manage multiple coding tasks
5. **Real-time feedback**: Live progress updates and detailed logging
6. **Git integration**: Automatic branching and commits with AI-generated names
7. **Scalable architecture**: Handle multiple concurrent tasks
8. **Cost control**: Direct API usage instead of v0's pricing
9. **Dual approach**: Keep v0 for quick iterations + agent for complex tasks

## Migration Phases

### Phase 1: Database Setup and Core Infrastructure

**Priority**: High | **Estimated Time**: 2-3 hours

#### Tasks:

- [ ] Add Drizzle ORM dependencies to `packages/db` (Supabase client already exists)
- [ ] Create database schema for task management in `packages/db`
- [ ] Set up database migrations and client configuration
- [ ] Add environment variables for Supabase connection
- [ ] Create basic task CRUD operations in `packages/db`

#### Files to Create/Modify:

- `packages/db/package.json` - Add Drizzle dependencies (Supabase client already exists)
- `packages/db/src/drizzle-schema.ts` - Add tasks table to existing schema
- `.env.example` - Environment variables template

### Phase 2: TRPC API Routes Migration

**Priority**: High | **Estimated Time**: 3-4 hours

#### Tasks:

- [ ] Create TRPC routers in `packages/api` for task management
- [ ] Implement task creation, retrieval, and deletion endpoints
- [ ] Add task status management and progress tracking
- [ ] Add GitHub integration for repository access
- [ ] Set up TRPC streaming for real-time task updates
- [ ] Create task execution endpoints with sandbox integration

#### Files to Create/Modify:

- `packages/api/src/tasks/tasks-router.ts` - Main task management TRPC router
- `packages/api/src/tasks/task-operations.ts` - Individual task operations
- `packages/api/src/root-router.ts` - Add tasks router to existing router
- `packages/api/src/utils/branch-name-generator.ts` - AI-generated branch names

### Phase 3: Sandbox Integration

**Priority**: High | **Estimated Time**: 2-3 hours

#### Tasks:

- [ ] Integrate Vercel Sandbox for isolated code execution in `packages/api`
- [ ] Set up sandbox creation and management TRPC endpoints
- [ ] Implement sandbox lifecycle (create, execute, cleanup)
- [ ] Add sandbox registry for tracking active sandboxes
- [ ] Configure sandbox environment variables

#### Files to Create/Modify:

- `packages/api/src/sandbox/sandbox-router.ts` - Sandbox TRPC router
- `packages/api/src/sandbox/sandbox-registry.ts` - Active sandbox tracking
- `packages/api/src/sandbox/commands.ts` - Sandbox command execution
- `packages/api/src/sandbox/config.ts` - Sandbox configuration

### Phase 4: Claude Agent Integration

**Priority**: Medium | **Estimated Time**: 2-3 hours

#### Tasks:

- [ ] Implement Claude agent integration in `packages/api`
- [ ] Set up Claude agent execution with sandbox
- [ ] Create agent execution TRPC endpoints
- [ ] Configure Claude API integration

#### Files to Create/Modify:

- `packages/api/src/agents/agents-router.ts` - Agent orchestration TRPC router
- `packages/api/src/agents/claude.ts` - Claude agent implementation

### Phase 5: UI Components Migration

**Priority**: Medium | **Estimated Time**: 4-5 hours

#### Tasks:

- [ ] Create new agent-based pages alongside existing v0 interface
- [ ] Add task management UI components
- [ ] Create task creation interface
- [ ] Add task status and sandbox iframe display
- [ ] Add task sidebar for managing multiple tasks
- [ ] Implement polling-based real-time updates (5-second intervals)
- [ ] Add task history and status tracking
- [ ] Create `useTask` hook for polling task updates
- [ ] Add navigation between v0 and agent interfaces

#### Files to Create/Modify:

- `apps/nextjs/src/app/agent/page.tsx` - New agent-based home page
- `apps/nextjs/src/app/agent/tasks/[taskId]/page.tsx` - Individual task view
- `apps/nextjs/src/app/(home)/_components/agent-composer.tsx` - Agent task creation
- `apps/nextjs/src/app/(home)/_components/agent-preview.tsx` - Agent task preview
- `apps/nextjs/src/app/(home)/_components/agent-sidebar.tsx` - Agent task sidebar
- `apps/nextjs/src/lib/hooks/use-task.ts` - Polling hook for task updates
- `apps/nextjs/src/trpc/client.ts` - TRPC client configuration

### Phase 6: Advanced Features

**Priority**: Low | **Estimated Time**: 2-3 hours

#### Tasks:

- [ ] Implement AI-generated branch names in `packages/api`
- [ ] Add Git integration for automatic commits
- [ ] Create task cancellation and timeout handling
- [ ] Add package manager detection and dependency installation
- [ ] Implement task cleanup and resource management

#### Files to Create/Modify:

- `packages/api/src/git/git-router.ts` - Git operations TRPC router
- `packages/api/src/git/package-manager.ts` - Package manager utilities
- `packages/api/src/utils/branch-name-generator.ts` - AI branch name generation

### Phase 7: Testing and Validation

**Priority**: High | **Estimated Time**: 2-3 hours

#### Tasks:

- [ ] Test task creation and execution flow
- [ ] Validate sandbox creation and cleanup
- [ ] Test multiple AI agents
- [ ] Verify real-time logging and progress tracking
- [ ] Test error handling and recovery
- [ ] Performance testing with multiple concurrent tasks

## Dependencies Migration

### Remove from `apps/nextjs/package.json`:

```json
{
  "@v0-sdk/react": "^0.3.1"
}
```

_Note: Keep v0-sdk for existing functionality, only remove if completely replacing v0._

### Add to `packages/db/package.json`:

```json
{
  "drizzle-kit": "^0.30.0",
  "drizzle-orm": "^0.36.4",
  "postgres": "^3.4.7"
}
```

_Note: Supabase client dependencies already exist. Some dependencies may already exist in the template-coding-agent and can be copied over._

### Add to `packages/api/package.json`:

```json
{
  "@vercel/sandbox": "^0.0.21",
  "nanoid": "^5.1.5",
  "zod": "^4.1.11"
}
```

### Add to `apps/nextjs/package.json`:

```json
{
  "ai": "5.0.51"
}
```

_Note: AI SDK only needed for frontend streaming, not backend. Keep existing v0-sdk._

## Environment Variables

### Required:

```bash
# Database (Supabase)
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
POSTGRES_URL=postgresql://username:password@host:port/database

# Claude Agent
ANTHROPIC_API_KEY=your_anthropic_key

# GitHub Integration
GITHUB_TOKEN=your_github_token

# Vercel Sandbox
VERCEL_TEAM_ID=your_team_id
VERCEL_PROJECT_ID=your_project_id
VERCEL_TOKEN=your_vercel_token
```

### Optional:

```bash
# Package Management
NPM_TOKEN=your_npm_token
```

## Database Schema

### Tasks Table:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  repo_url TEXT,
  install_dependencies BOOLEAN DEFAULT false,
  max_duration INTEGER DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  logs JSONB,
  error TEXT,
  branch_name TEXT,
  sandbox_url TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMP
);
```

## File Structure Changes

### New Directory Structure:

```
packages/
├── db/
│   ├── src/
│   │   ├── schema.ts
│   │   ├── client.ts
│   │   └── migrations/
│   └── drizzle.config.ts
├── api/
│   ├── src/
│   │   ├── tasks/
│   │   │   ├── tasks-router.ts
│   │   │   └── task-operations.ts
│   │   ├── agents/
│   │   │   ├── agents-router.ts
│   │   │   └── claude.ts
│   │   ├── sandbox/
│   │   │   ├── sandbox-router.ts
│   │   │   ├── sandbox-registry.ts
│   │   │   ├── commands.ts
│   │   │   └── config.ts
│   │   ├── git/
│   │   │   ├── git-router.ts
│   │   │   └── package-manager.ts
│   │   └── utils/
│   │       └── branch-name-generator.ts
│   └── package.json
└── ui/
    └── (existing components)

apps/
└── nextjs/
    ├── src/
    │   ├── app/
    │   │   ├── agent/                    # NEW: Agent-based interface
    │   │   │   ├── page.tsx
    │   │   │   └── tasks/
    │   │   │       └── [taskId]/
    │   │   │           └── page.tsx
    │   │   ├── (home)/                   # EXISTING: v0 interface
    │   │   │   ├── _components/
    │   │   │   │   ├── composer.tsx      # EXISTING: v0 composer
    │   │   │   │   ├── preview.tsx       # EXISTING: v0 preview
    │   │   │   │   ├── stream-provider.tsx # EXISTING: v0 streaming
    │   │   │   │   ├── agent-composer.tsx # NEW: Agent composer
    │   │   │   │   ├── agent-preview.tsx  # NEW: Agent preview
    │   │   │   │   └── agent-sidebar.tsx # NEW: Agent sidebar
    │   │   │   └── [[...chatId]]/
    │   │   │       └── page.tsx          # EXISTING: v0 chat
    │   │   ├── api/
    │   │   │   ├── chat/                 # EXISTING: v0 API
    │   │   │   │   └── route.ts
    │   │   │   └── trpc/                 # EXISTING: TRPC API
    │   │   │       └── [trpc]/
    │   │   │           └── route.ts
    │   │   └── (games)/                  # EXISTING: Games pages
    │   │       └── discover/
    │   │           └── page.tsx
    │   ├── lib/
    │   │   └── hooks/
    │   │       └── use-task.ts           # NEW: Task polling hook
    │   └── trpc/
    │       └── client.ts                 # EXISTING: TRPC client
    └── package.json
```

## Architecture Overview

### Data Flow:

1. **Frontend** (`apps/nextjs`) uses TRPC client for task operations
2. **TRPC Routers** (`packages/api/src/*`) handle all business logic
3. **Database** (`packages/db`) stores task state and logs
4. **Sandbox** (`packages/api/src/sandbox`) executes code safely
5. **Real-time Updates** via polling every 5 seconds
6. **TaskLogger** updates database with progress during execution

### Key Integration Points:

- Frontend uses TRPC client for all API calls
- TRPC routers use database client from `packages/db`
- Sandbox integration via Vercel Sandbox API
- Real-time updates through polling mechanism
- TaskLogger updates database during execution
- No Next.js API routes needed - everything in TRPC

### Integration with Existing Architecture:

#### Current TRPC Setup:

- **Root Router**: `packages/api/src/root-router.ts` (already has `aiRouter`)
- **TRPC Handler**: `apps/nextjs/src/app/api/trpc/[trpc]/route.ts`
- **Client**: `apps/nextjs/src/trpc/react.tsx`

#### Migration Strategy:

1. **Extend existing `aiRouter`** instead of creating new routers
2. **Add tasks table** to existing `packages/db/src/drizzle-schema.ts` (Supabase already configured)
3. **Copy sandbox logic** from `template-coding-agent/lib/sandbox/`
4. **Add new agent pages** alongside existing v0 interface
5. **Maintain existing auth flow** and user management
6. **Use Claude agent only** - no agent selection UI needed
7. **Leverage existing Supabase setup** - no database migration needed
8. **Implement everything in TRPC** - no Next.js API routes needed
9. **Keep v0 functionality** - add agent as alternative interface

#### Key Files to Copy from Template:

- `template-coding-agent/lib/sandbox/` → `packages/api/src/sandbox/`
- `template-coding-agent/lib/utils/` → `packages/api/src/utils/`
- Database schema and migrations
- UI components for task management

#### Dual Interface Approach:

**Keep Both Systems**: v0 for quick iterations + Agent for complex tasks

- **v0 Interface** (`/`): Quick chat-based game generation
- **Agent Interface** (`/agent`): Complex task-based development
- **Navigation**: Easy switching between interfaces
- **Shared Auth**: Both use same authentication system
- **Different Use Cases**:
  - v0: "Build a simple Flappy Bird game"
  - Agent: "Create a multiplayer racing game with physics engine"

**Benefits**:

- No disruption to existing users
- Gradual migration path
- Best of both worlds
- A/B testing capabilities

#### Real-time Updates Architecture:

**Polling-based Approach**: Simple and reliable real-time updates

- **Task Operations**: Handled by TRPC routers in `packages/api`
- **Real-time Updates**: Frontend polls every 5 seconds for task updates
- **Sandbox Integration**: TRPC endpoints for sandbox management
- **Frontend**: Uses TRPC client + polling for live progress
- **Task Logger**: Updates database with progress and logs in real-time

**How it Works**:

1. **Backend**: TaskLogger updates database with progress/logs during execution
2. **Frontend**: `useTask` hook polls `/api/tasks/[taskId]` every 5 seconds
3. **UI**: Components auto-update when new data arrives
4. **Auto-scroll**: Logs container scrolls to bottom on new entries

**Benefits**:

- Simple and reliable polling mechanism
- No complex WebSocket or streaming setup needed
- Database acts as single source of truth
- Easy to debug and maintain
- Works well with existing TRPC patterns

## Risk Assessment

### High Risk:

- **Sandbox Integration**: Vercel Sandbox setup and configuration
- **AI Agent Integration**: Multiple API integrations and error handling
- **TRPC Integration**: TRPC router setup and Next.js API route integration
- **Real-time Updates**: Streaming implementation with `useChat`

### Medium Risk:

- **Database Migration**: Schema changes and data migration in `packages/db`
- **UI/UX Changes**: User experience during transition from v0 to task-based system
- **Performance**: Multiple concurrent tasks and resource management
- **Package Dependencies**: Managing dependencies across multiple packages

### Low Risk:

- **Environment Setup**: Configuration and deployment
- **Dependency Management**: Package updates and compatibility

## Rollback Plan

If migration issues arise:

1. **Keep v0 integration** as fallback option
2. **Feature flags** to switch between systems
3. **Database backup** before migration
4. **Environment variable** to enable/disable new system
5. **Gradual rollout** with A/B testing

## Success Metrics

- [ ] Task creation and execution success rate > 95%
- [ ] Average task completion time < 5 minutes
- [ ] Sandbox creation success rate > 98%
- [ ] Real-time logging accuracy > 99%
- [ ] User satisfaction with new interface
- [ ] System stability under concurrent load

## Timeline Estimate

- **Phase 1-2**: 5-7 hours (Core infrastructure)
- **Phase 3-4**: 4-6 hours (Sandbox and Claude agent)
- **Phase 5**: 4-5 hours (UI migration)
- **Phase 6-7**: 4-6 hours (Advanced features and testing)

**Total Estimated Time**: 17-24 hours

## Next Steps

1. Review and approve this migration plan
2. Set up development environment with required credentials
3. Begin Phase 1 implementation
4. Regular checkpoints and progress updates
5. Testing and validation at each phase
6. Gradual rollout and monitoring

---

_This migration plan provides a comprehensive roadmap for transitioning from v0 to a self-hosted coding agent system while maintaining functionality and improving capabilities._
