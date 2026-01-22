// server.js - Simple Express Backend for VFX Market Pulse
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Use /tmp for ephemeral storage on Render (free tier)
const DATA_DIR = process.env.NODE_ENV === 'production' 
  ? '/tmp/data' 
  : path.join(__dirname, 'data');

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');

// In-memory fallback for production
let projectsCache = [];
let sourcesCache = {
  vitrina: { lastScrape: null, projectCount: 0, status: 'idle' },
  backstage: { lastScrape: null, projectCount: 0, status: 'idle' },
  mandy: { lastScrape: null, projectCount: 0, status: 'idle' },
  productionWeekly: { lastScrape: null, projectCount: 0, status: 'idle' }
};

// Initialize data directory
async function initDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    try {
      await fs.access(PROJECTS_FILE);
      const data = await fs.readFile(PROJECTS_FILE, 'utf8');
      projectsCache = JSON.parse(data);
    } catch {
      await fs.writeFile(PROJECTS_FILE, JSON.stringify([], null, 2));
      projectsCache = [];
    }
    
    try {
      await fs.access(SOURCES_FILE);
      const data = await fs.readFile(SOURCES_FILE, 'utf8');
      sourcesCache = JSON.parse(data);
    } catch {
      await fs.writeFile(SOURCES_FILE, JSON.stringify(sourcesCache, null, 2));
    }
  } catch (error) {
    console.log('Using in-memory storage (file system not available)');
  }
}

// Read projects
async function getProjects() {
  return projectsCache;
}

// Write projects
async function saveProjects(projects) {
  projectsCache = projects;
  try {
    await fs.writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  } catch (error) {
    console.log('Could not write to file, using memory only');
  }
  return true;
}

// Read source status
async function getSourceStatus() {
  return sourcesCache;
}

// Update source status
async function updateSourceStatus(sourceName, updates) {
  sourcesCache[sourceName] = { ...sourcesCache[sourceName], ...updates };
  try {
    await fs.writeFile(SOURCES_FILE, JSON.stringify(sourcesCache, null, 2));
  } catch (error) {
    console.log('Could not write to file, using memory only');
  }
  return sourcesCache[sourceName];
}

// API Routes

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'VFX Market Pulse API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      projects: '/api/projects',
      projectsByTier: '/api/projects/tier/:tier',
      sources: '/api/sources',
      scrape: 'POST /api/scrape/:source',
      stats: '/api/stats'
    }
  });
});

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await getProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Get projects by tier
app.get('/api/projects/tier/:tier', async (req, res) => {
  try {
    const projects = await getProjects();
    const filtered = projects.filter(p => p.tier === req.params.tier);
    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Get source status
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await getSourceStatus();
    res.json(sources);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch source status' });
  }
});

// Trigger scrape for a specific source
app.post('/api/scrape/:source', async (req, res) => {
  const sourceName = req.params.source;
  
  try {
    // Update status to scraping
    await updateSourceStatus(sourceName, { 
      status: 'scraping',
      lastScrape: new Date().toISOString()
    });
    
    // Import and run the appropriate scraper
    const scraper = require(`./scrapers/${sourceName}`);
    const newProjects = await scraper.scrape();
    
    // Get existing projects
    const existingProjects = await getProjects();
    
    // Merge new projects (avoid duplicates by title)
    const mergedProjects = [...existingProjects];
    newProjects.forEach(newProject => {
      const exists = existingProjects.find(p => p.title === newProject.title);
      if (!exists) {
        mergedProjects.push(newProject);
      }
    });
    
    // Save merged projects
    await saveProjects(mergedProjects);
    
    // Update source status
    await updateSourceStatus(sourceName, { 
      status: 'active',
      projectCount: newProjects.length
    });
    
    res.json({ 
      success: true, 
      projectsAdded: newProjects.length,
      totalProjects: mergedProjects.length,
      source: sourceName 
    });
    
  } catch (error) {
    console.error(`Error scraping ${sourceName}:`, error);
    await updateSourceStatus(sourceName, { status: 'error' });
    res.status(500).json({ error: error.message });
  }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const projects = await getProjects();
    const sources = await getSourceStatus();
    
    const stats = {
      totalProjects: projects.length,
      byTier: {
        tier1: projects.filter(p => p.tier === 'tier1').length,
        tier2: projects.filter(p => p.tier === 'tier2').length,
        tier3: projects.filter(p => p.tier === 'tier3').length,
        tier4: projects.filter(p => p.tier === 'tier4').length
      },
      byVFXNeeds: {
        extreme: projects.filter(p => p.vfxNeeds === 'Extreme').length,
        high: projects.filter(p => p.vfxNeeds === 'High').length,
        medium: projects.filter(p => p.vfxNeeds === 'Medium').length,
        low: projects.filter(p => p.vfxNeeds === 'Low').length
      },
      sources: sources,
      lastUpdated: new Date().toISOString()
    };
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// Start server
app.listen(PORT, async () => {
  await initDataDir();
  console.log(`🚀 VFX Market Pulse Backend running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 API endpoints available at http://localhost:${PORT}`);
});
