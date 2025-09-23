# Hacker News Agent

A Hacker News integration agent that fetches stories, extracts article content, analyzes comments, and provides content summaries through the official Hacker News API.

## Tools

- `fetch_hn_top_articles` - Fetch top N stories with optional article content extraction
- `fetch_hn_item_details` - Get detailed information for a specific story or comment by ID
- `summarize_hn_tldr` - Generate TLDR summaries and sentiment analysis for stories
- `slackbot_read_messages` - Read messages from Slack channels
- `slackbot_read_thread_replies` - Read replies to Slack threads
- `slackbot_read_message` - Read a specific Slack message by timestamp
- `slackbot_read_user_info` - Get information about Slack users

## Core Capabilities

### Story and Content Access
- Hacker News Firebase API integration for real-time story data
- Article content extraction from external URLs with readability parsing
- Story metadata including scores, timestamps, authors, and comment counts
- Time-based formatting ("2h ago", "3d ago") for human-readable timestamps

### Comment Analysis
- Hierarchical comment tree traversal with configurable depth limits
- Comment filtering with support for dead/deleted comment detection
- User attribution and parent-child relationship tracking
- Batch comment processing with concurrency controls

### Content Processing
- HTML parsing and text extraction from article URLs
- Content summarization with TLDR generation
- Sentiment analysis based on community comments
- Configurable content limits and character truncation

### Performance Features
- TTL-based caching system (2 minutes for top stories, 10 minutes for items)
- Concurrent request processing with configurable limits (default: 12)
- Automatic cache cleanup and memory management
- Timeout protections for external URL fetching

### Platform Integration
- Native Slack integration with emoji reactions and threading
- Multi-platform support for Slack channels and web interfaces
- Real-time status updates during content processing

## Use Cases

- Technology trend monitoring
- Competitive intelligence and market research
- Content curation for newsletters or reports
- Community sentiment analysis
- Developer ecosystem tracking
- Strategic planning based on technology discussions

## Technical Details

- **API**: Official Hacker News Firebase API
- **Caching**: In-memory TTL cache with automatic cleanup (60s intervals)
- **Concurrency**: Configurable parallel processing (1-32 requests, default 12)
- **Content Extraction**: HTML parsing with readability-focused text extraction
- **Timeouts**: 8-second timeout for external URL fetching
- **Error Handling**: Graceful fallback for failed article extractions