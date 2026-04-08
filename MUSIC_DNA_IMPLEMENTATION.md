# Music DNA Implementation Checklist

Complete this checklist to fully integrate the Music DNA feature into your app.

## Phase 1: Backend Setup (Days 1-2)

### Database
- [ ] Run `initializeMusicDNASchema()` to create tables
  - `user_dna_profiles`
  - `user_tracks`
  - Add `features` column to `tracks` table
- [ ] Verify tables exist: `\dt` in psql
- [ ] Verify indexes created: `\di` in psql

### API Endpoints
- [ ] Import musicDna functions in server.mjs
- [ ] Add `/api/user/dna` GET endpoint
- [ ] Add `/api/user/dna/refresh` POST endpoint
- [ ] Add `/api/user/sonic-twins` GET endpoint
- [ ] Test endpoints with curl/Postman

### Track Play Recording
- [ ] Import trackPlayLogger in relevant modules
- [ ] Add `recordTrackPlay()` call when track completes (>80% played)
- [ ] Populate track features from Spotify API or compute locally
- [ ] Test track recording by checking `user_tracks` table

## Phase 2: Frontend Setup (Days 2-3)

### Components
- [ ] Copy components to `src/components/`:
  - DNAProfile.jsx
  - DNAHelix.jsx
  - GenreBreakdown.jsx
  - SonicTwins.jsx
  - UserDNACard.jsx
  - musicDna.css
- [ ] Install any missing dependencies (if needed)

### Integration
- [ ] Import DNAProfile component in App.jsx
- [ ] Add route `/dna` → DNAProfile component
- [ ] Add navigation link "🧬 My DNA" in Sidebar
- [ ] Verify auth token is being sent with requests
- [ ] Test component loads without errors

### Styling
- [ ] Import musicDna.css in DNAProfile.jsx
- [ ] Verify colors match app theme
- [ ] Test responsiveness on mobile (<768px)
- [ ] Adjust colors/theme as needed

## Phase 3: Feature Population (Days 3-4)

### Get Track Features
Choose one approach:

**Option A: Spotify API (Recommended)**
- [ ] Integrate `enrichTrackWithFeatures()` when importing tracks
- [ ] Cache Spotify features in DB to avoid rate limits
- [ ] Set up Spotify API credentials in .env

**Option B: Use Existing Metadata**
- [ ] Extract genres from YouTube Music API
- [ ] Use track duration for basic energy estimation
- [ ] Map artist to archetype manually or via ML

**Option C: Default Features**
- [ ] Use DEFAULT_TRACK_FEATURES for all tracks initially
- [ ] Let users build profile gradually as they play

### Seed User Data
- [ ] For testing: Create test user with 50+ play records
- [ ] Manually call `recordTrackPlay()` to populate history
- [ ] Verify `user_tracks` table shows data

## Phase 4: Testing & Refinement (Days 4-5)

### Backend Tests
- [ ] Test `calculateUserDNA()` returns valid data
- [ ] Test `getUserDNA()` caching works (24hr TTL)
- [ ] Test `findSonicTwins()` returns 10 recommendations
- [ ] Test with edge case: new user (no plays)
- [ ] Test with heavy user (500+ plays)

### Frontend Tests
- [ ] Test DNAProfile loads without auth → redirects
- [ ] Test refresh button recalculates DNA
- [ ] Test tab switching (overview → genres → twins)
- [ ] Test on mobile (responsive layout)
- [ ] Test on slow connection (loading states)

### UI/UX Polish
- [ ] Verify helix animation is smooth (60fps)
- [ ] Check colors are accessible (contrast ratio)
- [ ] Verify error messages are clear
- [ ] Test share/download functionality
- [ ] Add loading skeletons if needed

## Phase 5: Production Deployment

### Environment
- [ ] Set `DNA_CACHE_TTL_SECONDS` in production .env
- [ ] Configure database connection pooling
- [ ] Set up monitoring/alerting for API endpoints

### Analytics
- [ ] Track "DNA viewed" events
- [ ] Track "Sonic twin clicked" events
- [ ] Monitor API response times

### Documentation
- [ ] Update README with DNA feature description
- [ ] Add screenshot/video of DNA profile
- [ ] Document API in OpenAPI/Swagger

## Optional Enhancements

### Phase 6A: Social Features
- [ ] Add DNA comparison between users
- [ ] Create shareable DNA cards (image export)
- [ ] Add leaderboards (most adventurous taste, etc.)

### Phase 6B: Advanced Analytics
- [ ] Track DNA evolution over time
- [ ] Show "taste changed" notifications
- [ ] Create monthly DNA reports

### Phase 6C: Recommendations
- [ ] Use DNA for better playlist recommendations
- [ ] Seed discover page with sonic twins
- [ ] Create "based on your DNA" sections

### Phase 6D: ML Integration
- [ ] Train model to predict archetype from audio
- [ ] Auto-classify new artists on import
- [ ] Improve sonic twins algorithm with embeddings

## Quick Start Commands

```bash
# Check database setup
psql -c "SELECT * FROM user_dna_profiles LIMIT 1"

# Test API
curl -X GET http://localhost:3001/api/user/dna \
  -H "Authorization: Bearer YOUR_TOKEN"

# Recalculate DNA
curl -X POST http://localhost:3001/api/user/dna/refresh \
  -H "Authorization: Bearer YOUR_TOKEN"

# Get sonic twins
curl -X GET "http://localhost:3001/api/user/sonic-twins?limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 401 Unauthorized | Check token in Authorization header |
| Empty DNA profile | Need 50+ tracks; check user_tracks table |
| Slow helix animation | Reduce pointCount in DNAHelix.jsx |
| Sonic twins empty | Check track count; may need Spotify features |
| Database connection error | Verify DATABASE_URL in .env |

## Success Metrics

- [ ] 80%+ of users view their DNA within first week
- [ ] Avg DNA calculation time < 500ms
- [ ] 40%+ click on sonic twins recommendations
- [ ] 25%+ try to share DNA card

## Timeline

- **Day 1-2**: Backend setup, database, API endpoints
- **Day 2-3**: Frontend components, styling
- **Day 3-4**: Populate test data, Spotify integration
- **Day 4-5**: Testing, UI refinement
- **Day 5+**: Deploy, monitor, iterate

**Total: ~5 days for MVP**

## Notes

- Music DNA caches for 24 hours; adjust `CACHE_TTL_SECONDS` as needed
- Sonic twins algorithm uses cosine similarity on 5 main features
- Consider adding Redis for caching if app scales to 10k+ users
- Spotify API has rate limits (429 errors); use batch requests

## Support

For questions:
1. Check MUSIC_DNA_GUIDE.md
2. Review component JSDoc comments
3. Check API response examples
4. Open a GitHub issue

---

**Last Updated**: 2024-01-15
**Version**: 1.0
**Status**: Ready for Production MVP
