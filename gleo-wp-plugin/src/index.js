import { render, useState, useEffect, useMemo, useRef, useCallback } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';
import { Activity, Zap, ShieldCheck } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import './index.css';

/* global gleoData */
const seoPluginActive = typeof gleoData !== 'undefined' ? gleoData.seoPluginActive : false;
const seoPluginName  = typeof gleoData !== 'undefined' ? gleoData.seoPluginName  : '';

/** Bot feed polling in Analytics (ms) — no Supabase Realtime; Node API + DB only. */
const GLEO_BOT_FEED_POLL_MS = 60 * 60 * 1000;

// ── Fix config ──────────────────────────────────────────────────────────────
const FIX_CONFIG = {
    schema:           { label: 'Deploy Schema',         needsInput: false, successMsg: 'JSON-LD schema markup is now active on this post, with expanded Organization wiring in your stored scan data.' },
    schema_enrich:    { label: 'Enrich structured data', needsInput: false, successMsg: 'Organization and publisher details were merged into your Gleo JSON-LD for this post.' },
    structure:        { label: 'Add Headings',          needsInput: false, successMsg: 'Semantic H2 headings have been added at natural break points in the article.' },
    formatting:       { label: 'Add Lists',             needsInput: false, successMsg: 'Dense paragraphs have been converted into bulleted lists.' },
    readability:      { label: 'Shorten Paragraphs',    needsInput: false, successMsg: 'Long paragraphs (80+ words) have been split into shorter chunks.' },
    content_depth:    { label: 'Expand Content',        needsInput: false, successMsg: 'In-depth paragraphs have been added to strengthen content quality.' },
    data_tables:      { label: 'Add Table',             needsInput: false, successMsg: 'A contextual comparison table has been added to your post.' },
    faq:              { label: 'Add FAQ Block',         needsInput: false, successMsg: 'A contextual FAQ section (including Q&A) has been added to your post.' },
    authority:        { label: 'Add Statistics',        needsInput: true,  prompt: 'Paste one statistic and its source (one short paragraph):', inputType: 'text', successMsg: 'A statistics callout was added using your text.' },
    credibility:      { label: 'Add Sources',           needsInput: true,  prompt: 'Paste URLs to authoritative sources (one per line):', inputType: 'lines', successMsg: 'A Sources & References section has been added to your post.' },
    opening_summary:  { label: 'Add opening summary',   needsInput: false, successMsg: 'An opening “In brief” summary block was added to the article.' },
    image_alt_text:   { label: 'Improve image alt text', needsInput: false, successMsg: 'Missing or empty image descriptions were filled using your post title (and saved on the attachments where possible).' },
    robots_txt_allow: { label: 'Allow AI crawlers (robots.txt)', needsInput: false, successMsg: 'Your site robots.txt now includes explicit Allow rules for common AI crawlers (site-wide).' },
    expert_quotes:    { label: 'Add expert perspective', needsInput: false, successMsg: 'A short expert-perspective quote block was added to the article.' },
};

// ── Helpers ─────────────────────────────────────────────────────────────────
const scoreChipClass = s => s >= 70 ? 'chip-hi' : s >= 40 ? 'chip-md' : 'chip-lo';

// ── SVG icons ────────────────────────────────────────────────────────────────
const IconScan = () => (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="6.5" cy="6.5" r="4"/>
        <path d="M11 11l2.5 2.5"/>
    </svg>
);
const IconAnalytics = () => (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="1,11 4.5,7 7.5,9 11,4 14,6"/>
    </svg>
);
const IconSettings = () => (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="7.5" cy="5" r="3"/>
        <path d="M2.5 13.5c0-2.8 2.2-5 5-5s5 2.2 5 5"/>
    </svg>
);
const IconChevron = ({ open }) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"
        style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
        <path d="M4.5 3L7.5 6L4.5 9"/>
    </svg>
);

// ── Toast ────────────────────────────────────────────────────────────────────
const SuccessToast = ({ message, onDismiss }) => {
    useEffect(() => { const t = setTimeout(onDismiss, 5000); return () => clearTimeout(t); }, [onDismiss]);
    return (
        <div className="gleo-toast">
            <span className="gleo-toast-icon">&#10003;</span>
            <span>{message}</span>
        </div>
    );
};

// ── Input Modal ──────────────────────────────────────────────────────────────
const InputModal = ({ title, prompt, inputType, onSubmit, onCancel }) => {
    const [value, setValue] = useState('');
    const submit = () => {
        if (!value.trim()) return;
        onSubmit(inputType === 'lines' ? value.split('\n').map(l => l.trim()).filter(Boolean) : value.trim());
    };
    return (
        <div className="gleo-modal-backdrop" onClick={onCancel}>
            <div className="gleo-modal" onClick={e => e.stopPropagation()}>
                <h3>{title}</h3>
                <p className="gleo-modal-prompt">{prompt}</p>
                <textarea className="gleo-modal-input" rows={inputType === 'lines' ? 5 : 3}
                    value={value} onChange={e => setValue(e.target.value)}
                    placeholder={inputType === 'lines' ? 'One item per line…' : 'Type here…'} />
                <div className="gleo-modal-actions">
                    <button className="gleo-btn gleo-btn-outline" onClick={onCancel}>Cancel</button>
                    <button className="gleo-btn gleo-btn-primary" onClick={submit} disabled={!value.trim()}>Apply Fix</button>
                </div>
            </div>
        </div>
    );
};

// ── SVG Line Chart (per-post history) ───────────────────────────────────────
const LineChart = ({ data }) => {
	if ( ! data || data.length === 0 ) {
		return <p className="gleo-no-data">No historical data yet. Run your first scan to start tracking.</p>;
	}
	const W = 680, H = 210;
	const pad = { top: 18, right: 24, bottom: 36, left: 36 };
	const cW = W - pad.left - pad.right;
	const cH = H - pad.top - pad.bottom;
	const xStep = data.length > 1 ? cW / ( data.length - 1 ) : cW / 2;
	const brandPts = data.map( ( d, i ) => ( { x: pad.left + i * xStep, y: pad.top + cH - ( d.avg_brand_rate / 10 ) * cH } ) );
	const scorePts = data.map( ( d, i ) => ( { x: pad.left + i * xStep, y: pad.top + cH - ( d.avg_geo_score / 100 ) * cH } ) );
	const path = pts => pts.map( ( p, i ) => `${ i === 0 ? 'M' : 'L' }${ p.x },${ p.y }` ).join( ' ' );
	return (
		<div className="gleo-chart-wrap">
			<svg viewBox={ `0 0 ${ W } ${ H }` } className="gleo-line-chart">
				{ [ 0, 25, 50, 75, 100 ].map( v => {
					const y = pad.top + cH - ( v / 100 ) * cH;
					return <line key={ v } x1={ pad.left } y1={ y } x2={ W - pad.right } y2={ y } stroke="#e2e8f0" strokeWidth="1"/>;
				} ) }
				<path d={ path( brandPts ) } fill="none" stroke="#0369a1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
				{ brandPts.map( ( p, i ) => <circle key={ i } cx={ p.x } cy={ p.y } r="3.5" fill="#0369a1"/> ) }
				<path d={ path( scorePts ) } fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
				{ scorePts.map( ( p, i ) => <circle key={ i } cx={ p.x } cy={ p.y } r="3.5" fill="#059669"/> ) }
				{ data.map( ( d, i ) => (
					<text key={ i } x={ pad.left + i * xStep } y={ H - 8 } textAnchor="middle" fontSize="10" fill="#9ca3af">
						{ d.scan_date ? d.scan_date.substring( 5 ) : `#${ i + 1 }` }
					</text>
				) ) }
				{ [ 0, 50, 100 ].map( v => (
					<text key={ v } x={ pad.left - 6 } y={ pad.top + cH - ( v / 100 ) * cH + 4 }
						textAnchor="end" fontSize="10" fill="#9ca3af">{ v }</text>
				) ) }
			</svg>
			<div className="gleo-chart-legend">
				<span className="gleo-legend-item"><span className="gleo-legend-dot" style={ { background: '#0369a1' } }></span>AI Visibility (×10)</span>
				<span className="gleo-legend-item"><span className="gleo-legend-dot" style={ { background: '#059669' } }></span>GEO Score</span>
			</div>
		</div>
	);
};

const PostHistoryChart = ( { postId, showHeading = true } ) => {
	const [ history, setHistory ] = useState( [] );
	const [ loading, setLoading ] = useState( true );
	useEffect( () => {
		setLoading( true );
		apiFetch( { path: `/gleo/v1/analytics/history?post_id=${ postId }` } )
			.then( res => setHistory( res.history || [] ) )
			.finally( () => setLoading( false ) );
	}, [ postId ] );
	return (
		<div className={ showHeading ? 'gleo-section' : 'gleo-post-history-chart-inline' }>
			{ showHeading ? (
				<>
					<h4>AI Visibility Over Time</h4>
					<p style={ { fontSize: 12.5, color: 'var(--fg-muted)', marginBottom: 10, marginTop: -4 } }>
						Tracks how often this post appears in AI-generated answers across scans.
					</p>
				</>
			) : (
				<p style={ { fontSize: 12.5, color: 'var(--fg-muted)', marginBottom: 10, marginTop: 0 } }>
					Tracks AI visibility and GEO score across scans for this post.
				</p>
			) }
			{ loading ? <p style={ { fontSize: 13, color: 'var(--fg-muted)' } }>Loading…</p> : <LineChart data={ history }/> }
		</div>
	);
};

// ── Analytics tab ───────────────────────────────────────────────────────────
const AnalyticsTab = () => {
	const [ sovData, setSovData ] = useState( null );
	const [ isRefreshing, setIsRefreshing ] = useState( false );
	const [ refreshMsg, setRefreshMsg ] = useState( null );
	const [ apiOffline, setApiOffline ] = useState( false );
	const [ botFeed, setBotFeed ] = useState( [] );
	const [ botFeedLoading, setBotFeedLoading ] = useState( false );
	const [ scanChartRows, setScanChartRows ] = useState( [] );
	const siteId = useMemo( () => {
		try {
			return new URL( typeof gleoData !== 'undefined' ? gleoData.siteUrl : '' ).hostname;
		} catch ( e ) {
			return '';
		}
	}, [] );
	const nodeBase = useMemo( () => ( typeof gleoData !== 'undefined' && gleoData.nodeApiUrl ) ? gleoData.nodeApiUrl : 'http://localhost:8765', [] );

	const handleRefreshSov = () => {
		setIsRefreshing( true ); setRefreshMsg( null ); setApiOffline( false );
		const queries = ( typeof gleoData !== 'undefined' ? ( gleoData.posts || [] ) : [] ).map( p => p.title );
		fetch( `${ nodeBase }/v1/analytics/sov/refresh`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { site_id: siteId, queries } ),
		} )
			.then( r => r.json() )
			.then( r => {
				if ( r.data ) {
					setSovData( r.data );
					setRefreshMsg( 'AI Visibility analysis complete.' );
				} else {
					setRefreshMsg( r.message || 'Updated.' );
				}
			} )
			.catch( () => setApiOffline( true ) )
			.finally( () => setIsRefreshing( false ) );
	};

	const fetchBotFeed = useCallback( () => {
		if ( ! siteId ) {
			return;
		}
		setBotFeedLoading( true );
		fetch( `${ nodeBase }/v1/analytics/bot-feed?site_id=${ encodeURIComponent( siteId ) }` )
			.then( r => r.json() )
			.then( r => setBotFeed( r.data || [] ) )
			.catch( () => {} )
			.finally( () => setBotFeedLoading( false ) );
	}, [ siteId, nodeBase ] );

	useEffect( () => {
		fetch( `${ nodeBase }/v1/analytics/sov?site_id=${ siteId }` )
			.then( r => r.json() ).then( r => { setSovData( r.data ); setApiOffline( false ); } )
			.catch( () => setApiOffline( true ) );
		fetchBotFeed();
		const id = setInterval( fetchBotFeed, GLEO_BOT_FEED_POLL_MS );
		return () => clearInterval( id );
	}, [ siteId, nodeBase, fetchBotFeed ] );

	useEffect( () => {
		apiFetch( { path: '/gleo/v1/scan/status' } )
			.then( res => {
				const rows = ( res.results || [] ).filter( r => r.post_id && r.result );
				setScanChartRows( rows.slice( 0, 8 ) );
			} )
			.catch( () => {} );
	}, [] );

	return (
		<div>
			<div className="gleo-page-header">
				<div>
					<h1>Analytics</h1>
					<p className="gleo-page-subtitle">AI visibility and crawler activity</p>
				</div>
			</div>
			<div className="gleo-analytics-grid">
				<div className="gleo-card">
					<div className="gleo-card-header">
						<h3>AI Visibility Share</h3>
						<button className="gleo-btn gleo-btn-outline" style={ { fontSize: 12, padding: '5px 12px' } }
							onClick={ handleRefreshSov } disabled={ isRefreshing }>
							{ isRefreshing ? 'Running…' : 'Refresh' }
						</button>
					</div>
					<div className="gleo-card-body">
						{ apiOffline && (
							<div style={ { background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 7, padding: '10px 14px', marginBottom: 12, fontSize: 12.5, color: '#92400e' } }>
								<strong>Analytics server is offline.</strong> Start <code style={ { background: '#fde68a', padding: '1px 5px', borderRadius: 3 } }>node index.js</code> in <code style={ { background: '#fde68a', padding: '1px 5px', borderRadius: 3 } }>gleo-node-api</code>, then click Refresh.
							</div>
						) }
						{ refreshMsg && <p style={ { fontSize: 12, color: 'var(--green)', marginBottom: 10 } }>{ refreshMsg }</p> }
						{ sovData ? ( () => {
							const shares = sovData.market_share || [];
							const yourIdx = shares.findIndex( s => s && s.isYou );
							const yourEntry = yourIdx >= 0 ? shares[ yourIdx ] : ( shares[ 0 ] || { name: 'Your Site', percentage: 0 } );
							const rank = ( yourIdx >= 0 ? yourIdx : 0 ) + 1;
							return (
								<div>
									<div style={ { textAlign: 'center', padding: '16px 0 20px' } }>
										<div style={ { fontSize: 48, fontWeight: 800, color: 'var(--blue)', letterSpacing: -2, lineHeight: 1 } }>
											{ yourEntry.percentage }%
										</div>
										<p style={ { fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 5 } }>of AI answers mention your site</p>
										<span style={ {
											display: 'inline-block', marginTop: 8,
											fontSize: 11.5, fontWeight: 700,
											background: rank === 1 ? '#dcfce7' : '#fef9c3',
											color: rank === 1 ? '#166534' : '#7c4e0f',
											padding: '3px 12px', borderRadius: 100,
										} }>
											#{ rank } in your industry
										</span>
									</div>
									<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
										{ shares.map( ( entry, i ) => {
											const isYou = entry === yourEntry;
											return (
												<div key={ i } style={ { display: 'flex', alignItems: 'center', gap: 8 } }>
													<span style={ { fontSize: 11, width: 18, color: 'var(--fg-muted)', textAlign: 'right', fontWeight: 600 } }>#{ i + 1 }</span>
													<span style={ { fontSize: 13, width: 120, fontWeight: isYou ? 700 : 400, color: isYou ? 'var(--fg)' : 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>
														{ isYou ? 'Your Site' : entry.name }
													</span>
													<div style={ { flex: 1, background: '#f1f5f9', borderRadius: 4, height: 7, overflow: 'hidden' } }>
														<div style={ { width: `${ entry.percentage }%`, height: '100%', background: isYou ? 'var(--blue)' : '#cbd5e1', borderRadius: 4, transition: 'width 1s ease' } }/>
													</div>
													<span style={ { fontSize: 12.5, fontWeight: 700, width: 32, textAlign: 'right', color: isYou ? 'var(--blue)' : 'var(--fg-muted)' } }>{ entry.percentage }%</span>
												</div>
											);
										} ) }
									</div>
									<p style={ { fontSize: 11, color: 'var(--fg-muted)', marginTop: 14, lineHeight: 1.5, borderTop: '1px solid var(--border-lt)', paddingTop: 10 } }>
										Based on AI queries for your recent posts.
									</p>
								</div>
							);
						} )() : (
							<div className="gleo-no-data-v2">
								<Zap size={ 28 }/>
								<p>No data yet. Click Refresh to run your first AI visibility analysis.</p>
							</div>
						) }
					</div>
				</div>

				<div className="gleo-card">
					<div className="gleo-card-header">
						<h3>AI Crawler Activity</h3>
						<div style={ { display: 'flex', alignItems: 'center', gap: 10 } }>
							<span className="gleo-card-meta">Refreshes hourly</span>
							<button type="button" className="gleo-btn gleo-btn-outline" style={ { fontSize: 12, padding: '5px 12px' } }
								onClick={ fetchBotFeed } disabled={ botFeedLoading || ! siteId }>
								{ botFeedLoading ? 'Loading…' : 'Refresh list' }
							</button>
						</div>
					</div>
					<div className="gleo-card-body">
						<p style={ { fontSize: 12.5, color: 'var(--fg-muted)', marginBottom: 14, marginTop: -4 } }>
							See when AI bots like ChatGPT and Perplexity visit your site. Data comes from your analytics server (and database if configured).
						</p>
						<div className="gleo-bot-feed">
							{ botFeed.length > 0 ? botFeed.map( ( hit, i ) => (
								<div key={ hit.id || i } className="gleo-bot-hit-item">
									<div className="gleo-bot-icon-wrap"><ShieldCheck size={ 14 }/></div>
									<div className="gleo-bot-details">
										<div className="gleo-bot-row">
											<strong>{ hit.bot_name }</strong>
											<span className="gleo-bot-time">{ formatDistanceToNow( new Date( hit.timestamp ) ) } ago</span>
										</div>
										<div className="gleo-bot-path">Crawled: <code>{ hit.request_path }</code></div>
									</div>
								</div>
							) ) : (
								<div className="gleo-no-data-v2">
									<Activity size={ 28 }/>
									<p>No bot visits recorded yet. When the analytics API and database are set up, new crawler hits appear here (this list also refreshes about once an hour automatically).</p>
								</div>
							) }
						</div>
					</div>
				</div>
			</div>

			{ scanChartRows.length > 0 && (
				<div className="gleo-card gleo-analytics-history-card">
					<div className="gleo-card-header">
						<h3>GEO score &amp; AI visibility by post</h3>
						<span className="gleo-card-meta">From recent scans</span>
					</div>
					<div className="gleo-card-body">
						{ scanChartRows.map( row => (
							<div key={ row.post_id } className="gleo-analytics-post-chart">
								<p className="gleo-analytics-post-chart-title">{ row.result?.title || `Post #${ row.post_id }` }</p>
								<PostHistoryChart postId={ row.post_id } showHeading={ false } />
							</div>
						) ) }
					</div>
				</div>
			) }
		</div>
	);
};

// ── Signal chip ──────────────────────────────────────────────────────────────
const Signal = ({ label, value, good, fixed }) => (
    <div className={`gleo-signal ${good === true || fixed ? 'good' : good === false ? 'bad' : ''}`}>
        <span className="gleo-signal-label">{label}</span>
        <span className="gleo-signal-value">{value}{fixed ? ' ✓' : ''}</span>
    </div>
);

const LayoutCritiqueSeverityBadge = ( { severity } ) => {
    const map = {
        high: { bg: 'rgba(220,38,38,0.25)', color: '#fecaca', text: 'High' },
        medium: { bg: 'rgba(217,119,6,0.25)', color: '#fde68a', text: 'Medium' },
        low: { bg: 'rgba(37,99,235,0.2)', color: '#bfdbfe', text: 'Low' },
    };
    const x = map[ severity ] || map.low;
    return (
        <span style={ { fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '3px 8px', borderRadius: 6, background: x.bg, color: x.color } }>{ x.text }</span>
    );
};

/** After Optimize: AI review of the polished page (preview overlay only). */
const LayoutCritiquePanel = ( { critique, onContinue } ) => {
    if ( ! critique ) {
        return null;
    }
    const overview = typeof critique.overview === 'string' ? critique.overview.trim() : '';
    const issues = Array.isArray( critique.issues ) ? critique.issues : [];
    const strengths = Array.isArray( critique.strengths ) ? critique.strengths.filter( Boolean ).slice( 0, 3 ) : [];
    if ( ! overview && issues.length === 0 ) {
        return null;
    }
    const panelStyle = { flex: 1, overflowY: 'auto', padding: '28px 36px 40px', background: '#0f172a', color: '#e2e8f0' };
    const subStyle = { color: '#94a3b8', fontSize: 14, lineHeight: 1.55 };
    const titleStyle = { margin: '0 0 12px', fontSize: 22, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' };
    return (
        <div className="gleo-layout-critique-panel" style={ panelStyle }>
            <h4 style={ titleStyle }>Your optimized page — quick review</h4>
            <p style={ { ...subStyle, marginBottom: overview ? 14 : 10 } }>
                Gemini just reviewed the <strong style={ { color: '#e2e8f0' } }>saved, polished version</strong> of this post (not the GEO score card). When you’re ready, continue to the live preview below.
            </p>
            { overview ? (
                <p style={ { margin: '0 0 18px', fontSize: 15, lineHeight: 1.65, color: '#f1f5f9' } }>{ overview }</p>
            ) : null }
            { strengths.length > 0 ? (
                <div style={ { marginBottom: 18 } }>
                    <div style={ { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 8 } }>Strengths</div>
                    <ul style={ { margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 13, lineHeight: 1.5 } }>
                        { strengths.map( ( s, i ) => (
                            <li key={ i } style={ { marginBottom: 4 } }>{ s }</li>
                        ) ) }
                    </ul>
                </div>
            ) : null }
            { issues.length > 0 ? (
                <div style={ { marginBottom: 28 } }>
                    <div style={ { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 10 } }>Still worth improving</div>
                    <div style={ { display: 'flex', flexDirection: 'column', gap: 12 } }>
                        { issues.map( ( iss, i ) => (
                            <div key={ i } style={ {
                                borderRadius: 10,
                                padding: '12px 14px',
                                background: 'rgba(30,41,59,0.85)',
                                border: '1px solid rgba(148,163,184,0.2)',
                            } }>
                                <div style={ { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' } }>
                                    <LayoutCritiqueSeverityBadge severity={ iss.severity } />
                                    <span style={ { fontWeight: 700, fontSize: 13, color: '#f8fafc' } }>{ iss.category || 'Issue' }</span>
                                </div>
                                <p style={ { margin: '0 0 8px', fontSize: 13, lineHeight: 1.5, color: '#cbd5e1' } }>{ iss.observation }</p>
                                <p style={ { margin: 0, fontSize: 12, lineHeight: 1.5, color: '#93c5fd' } }>
                                    <strong style={ { fontWeight: 700 } }>Suggestion:</strong> { iss.suggestion }
                                </p>
                            </div>
                        ) ) }
                    </div>
                </div>
            ) : null }
            { typeof onContinue === 'function' ? (
                <button type="button" className="gleo-btn gleo-btn-primary" style={ { padding: '12px 28px', fontSize: 15, fontWeight: 700, borderRadius: 10 } } onClick={ onContinue }>
                    Continue to live preview
                </button>
            ) : null }
        </div>
    );
};

// ── Priority section ─────────────────────────────────────────────────────────
const PrioritySection = ({ priority, items, onFix }) => {
    const [open, setOpen] = useState(priority === 'critical' || priority === 'high' || priority === 'medium');
    if (!items || items.length === 0) return null;
    const labels   = { critical: 'Critical Issues', high: 'High Priority', medium: 'Improvements', positive: 'Positive Signals' };
    const dotClass = { critical: 'dot-critical', high: 'dot-high', medium: 'dot-medium', positive: 'dot-positive' };
    return (
        <div className="gleo-priority-section">
            <div className="gleo-priority-header" onClick={() => setOpen(!open)}>
                <span className={`gleo-priority-dot ${dotClass[priority]}`}></span>
                <span className="gleo-priority-title">{labels[priority] || priority}</span>
                <span className="gleo-priority-count">{items.length}</span>
                <IconChevron open={open}/>
            </div>
            {open && (
                <div className="gleo-priority-items">
                    {items.map((item, i) => (
                        <div key={i} className="gleo-rec-card">
                            <div className="gleo-rec-card-body">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                    <strong>{item.area}</strong>
                                    {item.maxScore !== undefined && (
                                        <span className="gleo-rec-score-tag"
                                            style={{ color: item.score === item.maxScore ? 'var(--green)' : item.score > 0 ? 'var(--amber)' : 'var(--red)' }}>
                                            {item.score}/{item.maxScore}
                                        </span>
                                    )}
                                </div>
                                <p>{item.message}</p>
                            </div>
                            <div style={{ flexShrink: 0, paddingTop: 2 }}>
                                {item.fixType ? (
                                    <button className="gleo-btn gleo-btn-primary"
                                        style={{ fontSize: 12, padding: '5px 12px' }}
                                        onClick={() => onFix(item.fixType, item)}
                                        disabled={item.applied || item.applying}>
                                        {item.applied ? 'Applied' : item.applying ? 'Fixing…' : 'Fix'}
                                    </button>
                                ) : (
                                    <span className="gleo-manual-tag">Info</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ── Scan Complete Modal ──────────────────────────────────────────────────────
const ScanCompleteModal = ( { onClose } ) => (
    <div className="gleo-modal-backdrop" onClick={ onClose }>
        <div className="gleo-modal gleo-scan-modal" onClick={ e => e.stopPropagation() }>
            <h3 className="gleo-scan-modal-title">Analysis complete</h3>
            <p className="gleo-scan-modal-lead">
                Your posts were scored for AI search visibility. Open the dashboard to see each report, preview the live page, and apply fixes in a few clicks.
            </p>
            <button type="button" className="gleo-btn gleo-btn-primary gleo-scan-modal-cta" onClick={ onClose }>
                View report and fix your site
            </button>
        </div>
    </div>
);

// ── Site Preview ─────────────────────────────────────────────────────────────
const gleoPreviewContentRoot = ( doc ) => (
    doc.querySelector( '.entry-content, .wp-block-post-content, article .entry-content' ) ||
    doc.querySelector( 'main article, article.post, .wp-site-blocks' ) ||
    doc.body
);

const SitePreview = ( { url, onClose, onApplyAll, applyingAll, allApplied, optimizeStatus, optimizeCritique, geminiPolished = false, onOptimizeSite } ) => {
    /** After a successful Optimize, optional AI review of the *polished* HTML only (not the GEO report). */
    const hasCritiqueGate = useMemo( () => Boolean(
        optimizeCritique && geminiPolished && (
            ( typeof optimizeCritique.overview === 'string' && optimizeCritique.overview.trim() )
            || ( Array.isArray( optimizeCritique.issues ) && optimizeCritique.issues.length > 0 )
        )
    ), [ optimizeCritique, geminiPolished ] );
    const [ previewPhase, setPreviewPhase ] = useState( 'live' );
    /** Without this, the critique effect kept resetting phase to "critique" after the user clicked Continue — the live iframe and AI tour never appeared. */
    const [ critiqueDismissed, setCritiqueDismissed ] = useState( false );
    useEffect( () => {
        if ( optimizeStatus ) {
            setCritiqueDismissed( false );
        }
    }, [ optimizeStatus ] );
    useEffect( () => {
        if ( optimizeStatus ) {
            return;
        }
        if ( hasCritiqueGate && ! critiqueDismissed ) {
            setPreviewPhase( 'critique' );
        } else {
            setPreviewPhase( 'live' );
        }
    }, [ optimizeStatus, hasCritiqueGate, critiqueDismissed ] );
    const [ iframeKey, setIframeKey ] = useState( Date.now() );
    const [ iframeLoaded, setIframeLoaded ] = useState( false );
    const iframeRef = useRef( null );
    const prevAllApplied = useRef( allApplied );
    const [ tourState, setTourState ] = useState( { active: false, step: 0, elements: [] } );
    const [ showTourPrompt, setShowTourPrompt ] = useState( false );
    const [ tourReplayUnlocked, setTourReplayUnlocked ] = useState( false );

    const iframeSrc = ( () => {
        let baseUrl = url || '';
        if ( baseUrl && ! baseUrl.includes( 'gleo_iframe=' ) ) {
            baseUrl += ( baseUrl.includes( '?' ) ? '&' : '?' ) + 'gleo_iframe=1';
        }
        const sep = baseUrl.includes( '?' ) ? '&' : '?';
        return `${ baseUrl }${ sep }gleo_cb=${ iframeKey }`;
    } )();

    useEffect( () => {
        if ( ! applyingAll && allApplied ) {
            setIframeKey( Date.now() );
            setIframeLoaded( false );
        }
    }, [ applyingAll, allApplied ] );

    useEffect( () => {
        if ( allApplied && prevAllApplied.current === false ) {
            setTourReplayUnlocked( false );
            setShowTourPrompt( false );
        }
        prevAllApplied.current = allApplied;
    }, [ allApplied ] );

    const finishTourSession = () => {
        const doc = iframeRef.current?.contentDocument;
        if ( doc ) {
            doc.querySelectorAll( '.gleo-dimmed' ).forEach( e => e.classList.remove( 'gleo-dimmed' ) );
            doc.querySelectorAll( '.gleo-highlight' ).forEach( e => e.classList.remove( 'gleo-highlight' ) );
        }
        setTourState( { active: false, step: 0, elements: [] } );
        setTourReplayUnlocked( true );
    };

    // Auto-scroll to first Gleo block when iframe loads after fixes applied
    useEffect( () => {
        if ( previewPhase !== 'live' || ! iframeLoaded || ! allApplied ) {
            return;
        }
        const timer = setTimeout( () => {
            const doc = iframeRef.current?.contentDocument;
            if ( ! doc ) {
                return;
            }
            const root = gleoPreviewContentRoot( doc );
            const first = root.querySelector( '.gleo-table-block, .gleo-qa-block, .gleo-faq-wrap, h2.wp-block-heading.gleo-section-heading, h2.wp-block-heading' );
            if ( first ) {
                first.scrollIntoView( { behavior: 'smooth', block: 'center' } );
            }
            setShowTourPrompt( true );
        }, 600 );
        return () => clearTimeout( timer );
    }, [ previewPhase, iframeLoaded, allApplied ] );

    const startTour = () => {
        setShowTourPrompt( false );
        setTourReplayUnlocked( false );
        const doc = iframeRef.current?.contentDocument;
        if ( ! doc ) {
            return;
        }
        const root = gleoPreviewContentRoot( doc );
        /** Drop steps whose target sits inside another step’s target (e.g. FAQ item vs whole FAQ). */
        const dedupeNestedTourTargets = ( entries ) =>
            entries.filter( ( e, i, arr ) =>
                ! arr.some( ( o, j ) => j !== i && o.el !== e.el && o.el.contains( e.el ) )
            );
        const possibleSteps = [
            {
                title: 'Quick Summary',
                blurb: 'A concise opening summary helps AI systems capture the core context before reading the full page.',
                find: () => root.querySelector( '.gleo-opening-summary-wrap' ) || root.querySelector( '.gleo-direct-answer' ),
            },
            {
                title: 'Figures & Evidence',
                blurb: 'This block surfaces numbers and claims so AI answers and readers can cite your page as a credible source.',
                find: () => root.querySelector( '.gleo-stats-callout' ),
            },
            {
                title: 'Comparison Layout',
                blurb: 'Side‑by‑side rows give models a scannable summary of options, which often gets quoted in AI overviews.',
                find: () => root.querySelector( '.gleo-table-block' ),
            },
            {
                title: 'Direct Answers',
                blurb: (
                    <>
                        The <strong style={ { color: '#7dd3fc', fontWeight: 700 } }>Q&A block</strong> (green ring) gives a tight question-and-answer pair so assistants can quote an accurate definition.
                    </>
                ),
                find: () => root.querySelector( '.gleo-qa-block' ),
            },
            {
                title: 'Common Questions',
                blurb: (
                    <>
                        The <strong style={ { color: '#7dd3fc', fontWeight: 700 } }>FAQ accordion</strong> (highlighted) gives expandable answers that target long‑tail queries and clear structured text for crawlers.
                    </>
                ),
                find: () => root.querySelector( '.gleo-faq-wrap .gleo-faq-accordion' ) || root.querySelector( '.gleo-faq-wrap' ),
            },
            {
                title: 'Section Structure',
                blurb: (
                    <>
                        The <strong style={ { color: '#7dd3fc', fontWeight: 700 } }>section heading</strong> with the Gleo label (highlighted) breaks the article into chunks that are easier for people and AI to navigate.
                    </>
                ),
                find: () => root.querySelector( 'h2.wp-block-heading.gleo-section-heading' ),
            },
            {
                title: 'Reference Signals',
                blurb: 'Source links and references reinforce trust and help models ground answers in verifiable material.',
                find: () => {
                    const h2s = root.querySelectorAll( 'h2.wp-block-heading, h2' );
                    const sourceHeading = Array.from( h2s ).find( h => /sources|references/i.test( h.textContent || '' ) );
                    if ( sourceHeading ) {
                        return sourceHeading;
                    }
                    return root.querySelector( 'ol.wp-block-list, ul.wp-block-list' );
                },
            },
            {
                title: 'Structured Data',
                blurb: 'JSON‑LD in the page head tells search and AI systems what this content is about without changing what visitors see.',
                isHead: true,
                find: () => doc.head?.querySelector( 'script[type="application/ld+json"]' ),
            },
        ];
        let found = [];
        const seen = new Set();
        for ( const step of possibleSteps ) {
            const el = typeof step.find === 'function' ? step.find() : null;
            if ( el && ! seen.has( el ) ) {
                const entry = { el, title: step.title, text: step.blurb || '', isHead: !! step.isHead };
                if ( step.isHead && el.textContent ) {
                    try {
                        entry.schemaPayload = JSON.parse( el.textContent );
                    } catch ( e ) {}
                }
                found.push( entry );
                seen.add( el );
            }
        }
        found = dedupeNestedTourTargets( found );
        if ( ! found.length ) {
            alert( 'No AI blocks found yet. Ensure fixes are applied first.' );
            return;
        }
        if ( ! doc.getElementById( 'gleo-tour-styles' ) ) {
            const s = doc.createElement( 'style' );
            s.id = 'gleo-tour-styles';
            s.textContent = '.gleo-dimmed{transition:opacity .35s;opacity:0.22;filter:grayscale(55%);pointer-events:none}.gleo-highlight{opacity:1!important;filter:none!important;position:relative;z-index:999999;border-radius:14px;pointer-events:auto;outline:3px solid #34d399;outline-offset:3px;box-shadow:0 0 0 20000px rgba(15,23,42,.82),0 0 0 1px rgba(52,211,153,.9) inset,0 0 48px rgba(52,211,153,.55),0 12px 40px rgba(59,130,246,.35);background:rgba(15,23,42,.08)!important;transition:box-shadow .2s ease,outline-color .2s ease}';
            doc.head.appendChild( s );
        }
        setTourState( { active: true, step: 0, elements: found } );
    };

    useEffect( () => {
        if ( ! tourState.active ) {
            return;
        }
        const doc = iframeRef.current?.contentDocument;
        if ( ! doc ) {
            return;
        }
        doc.querySelectorAll( '.gleo-dimmed' ).forEach( e => e.classList.remove( 'gleo-dimmed' ) );
        doc.querySelectorAll( '.gleo-highlight' ).forEach( e => e.classList.remove( 'gleo-highlight' ) );
        const cur = tourState.elements[ tourState.step ];
        if ( ! cur ) {
            return;
        }
        if ( ! cur.isHead ) {
            const dimHost = gleoPreviewContentRoot( doc );
            let topBlocks;
            if ( dimHost ) {
                const scoped = dimHost.querySelectorAll( ':scope > *' );
                topBlocks = scoped.length
                    ? scoped
                    : Array.from( doc.body.children ).filter( c => c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE' );
            } else {
                topBlocks = Array.from( doc.body.children ).filter( c => c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE' );
            }
            topBlocks.forEach( c => c.classList.add( 'gleo-dimmed' ) );
            let t = cur.el;
            while ( t && t !== doc.body ) {
                t.classList.remove( 'gleo-dimmed' );
                t = t.parentElement;
            }
            cur.el.classList.add( 'gleo-highlight' );
            requestAnimationFrame( () => {
                cur.el.scrollIntoView( { behavior: 'smooth', block: 'center', inline: 'nearest' } );
            } );
        } else {
            Array.from( doc.body.children ).forEach( c => c.classList.add( 'gleo-dimmed' ) );
            iframeRef.current.contentWindow.scrollTo( { top: 0, behavior: 'smooth' } );
        }
    }, [ tourState ] );

    const stopTour = () => {
        const doc = iframeRef.current?.contentDocument;
        if ( doc ) {
            doc.querySelectorAll( '.gleo-dimmed' ).forEach( e => e.classList.remove( 'gleo-dimmed' ) );
            doc.querySelectorAll( '.gleo-highlight' ).forEach( e => e.classList.remove( 'gleo-highlight' ) );
        }
        setTourState( { active: false, step: 0, elements: [] } );
    };

    return (
        <div className="gleo-preview-overlay" style={ { background: '#0f172a', display: 'flex', flexDirection: 'column' } }>
            <div className="gleo-preview-toolbar gleo-preview-header" style={ { padding: '16px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.12)' } }>
                <div style={ { display: 'flex', alignItems: 'center', gap: 24 } }>
                    <div style={ { fontSize: 18, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' } }>
                        { optimizeStatus ? 'Working on your site' : previewPhase === 'critique' ? 'Review optimized page' : 'Live Preview' }
                    </div>
                    { optimizeStatus ? (
                        <span style={ { color: '#94a3b8', fontSize: 13, fontWeight: 500 } }>Please keep this window open.</span>
                    ) : previewPhase === 'live' && typeof onOptimizeSite === 'function' ? (
                        <button type="button" className="gleo-btn gleo-btn-primary" style={ { fontSize: 14, padding: '9px 22px', borderRadius: 10 } }
                            onClick={ onOptimizeSite } disabled={ applyingAll || Boolean( optimizeStatus ) }>
                            Optimize site
                        </button>
                    ) : null }
                    { ! optimizeStatus && previewPhase === 'live' && ! allApplied ? (
                        <button className="gleo-btn gleo-btn-outline" style={ { fontSize: 14, padding: '9px 22px', borderRadius: 10 } }
                            onClick={ onApplyAll } disabled={ applyingAll }>
                            { applyingAll ? 'Applying quick fixes…' : 'Apply quick fixes' }
                        </button>
                    ) : null }
                    { ! optimizeStatus && previewPhase === 'live' && allApplied ? (
                        <div style={ { display: 'flex', alignItems: 'center', gap: 8 } }>
                            <span style={ { fontSize: 16 } }>✅</span>
                            <span style={ { color: '#4ade80', fontWeight: 700, fontSize: 14 } }>All auto-fixes active</span>
                            { tourReplayUnlocked && ! tourState.active ? (
                                <button type="button" className="gleo-btn gleo-preview-chrome-btn" onClick={ startTour } style={ { marginLeft: 12, padding: '6px 14px', fontSize: 12, borderRadius: 8 } }>Restart AI Tour</button>
                            ) : null }
                        </div>
                    ) : ! optimizeStatus && previewPhase === 'critique' ? (
                        <span style={ { color: '#94a3b8', fontSize: 13, fontWeight: 500 } }>Then continue to the live page.</span>
                    ) : null }
                </div>
                <button type="button" className="gleo-btn gleo-preview-chrome-btn gleo-preview-exit-btn"
                    style={ { fontSize: 13, padding: '10px 22px', borderRadius: 8, fontWeight: 700 } }
                    onClick={ () => { stopTour(); onClose(); } }>Exit preview</button>
            </div>

            <div className="gleo-preview-body gleo-preview-body--flex" style={ { flexDirection: 'column', padding: 0, margin: 0, position: 'relative', background: ( optimizeStatus || previewPhase === 'critique' ) ? '#0f172a' : '#f1f5f9', flex: 1, minHeight: 0 } }>
                { optimizeStatus ? (
                    <div style={ { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32 } }>
                        <p style={ { color: '#f1f5f9', fontSize: 17, fontWeight: 700, marginBottom: 18, textAlign: 'center', maxWidth: 440, lineHeight: 1.45 } }>{ optimizeStatus.label }</p>
                        <div className="gleo-progress-bar" style={ { width: 'min(440px, 90vw)', height: 11, borderRadius: 9999, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' } }>
                            <div className="gleo-progress-fill" style={ { width: `${ Math.min( 100, Math.max( 0, optimizeStatus.pct ) ) }%`, height: '100%', transition: 'width 0.35s ease', borderRadius: 9999 } } />
                        </div>
                        <p style={ { color: '#94a3b8', fontSize: 13, marginTop: 16, textAlign: 'center', maxWidth: 420, lineHeight: 1.5 } }>
                            This uses Gemini. Your page is sent for review, then the improved version is saved and shown here.
                        </p>
                    </div>
                ) : previewPhase === 'critique' ? (
                    <LayoutCritiquePanel critique={ optimizeCritique } onContinue={ () => {
                        setCritiqueDismissed( true );
                        setIframeKey( Date.now() );
                        setIframeLoaded( false );
                    } } />
                ) : (
                    <>
                { ( applyingAll || ( ! iframeLoaded && allApplied ) ) && (
                    <div className="gleo-preview-loading" style={ { position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(15,23,42,0.75)', backdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 } }>
                        <p style={ { color: '#fff', fontSize: 15, fontWeight: 600, marginBottom: 16, textAlign: 'center' } }>{ applyingAll ? 'Applying quick fixes…' : 'Loading preview…' }</p>
                        <div className="gleo-progress-bar" style={ { width: 'min(320px, 85vw)', height: 10, borderRadius: 9999, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' } }>
                            <div className="gleo-progress-fill" style={ { width: applyingAll ? '62%' : '85%', height: '100%', borderRadius: 9999, transition: 'width 0.5s ease' } } />
                        </div>
                    </div>
                ) }
                <div className="gleo-preview-iframe-shell">
                    <iframe ref={ iframeRef } className="gleo-preview-iframe" key={ iframeKey } src={ iframeSrc }
                        onLoad={ () => setIframeLoaded( true ) }
                        loading="eager"
                        title="Site Preview"/>
                </div>

                { showTourPrompt && ! tourState.active && (
                    <div style={ { position: 'absolute', top: 30, right: 30, background: '#ffffff', padding: '24px', borderRadius: 20, width: 340, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)', zIndex: 100, border: '1px solid #e2e8f0' } }>
                        <button type="button" onClick={ () => { setShowTourPrompt( false ); setTourReplayUnlocked( true ); } } style={ { position: 'absolute', top: 12, right: 16, background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer' } }>×</button>
                        <div style={ { width: 44, height: 44, background: 'var(--gleo-accent-bg)', color: 'var(--gleo-accent)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, marginBottom: 16 } }>✨</div>
                        <h4 style={ { margin: '0 0 8px', fontSize: 18, color: '#0f172a', fontWeight: 800 } }>AI Changes Applied</h4>
                        <p style={ { color: '#64748b', fontSize: 14, margin: '0 0 20px', lineHeight: 1.5 } }>Walk through where new GEO blocks were added.</p>
                        <button className="gleo-btn gleo-btn-primary" type="button" onClick={ startTour } style={ { width: '100%', padding: '12px', fontSize: 14, fontWeight: 700, borderRadius: 12 } }>
                            Start Guided AI Tour
                        </button>
                    </div>
                ) }

                { tourState.active && tourState.elements[ tourState.step ] && (
                    <div style={ {
                        position: 'absolute',
                        top: 10,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        background: '#1e293b',
                        padding: '20px 24px',
                        borderRadius: 20,
                        width: 'min(92vw, 480px)',
                        maxHeight: 'min(42vh, 360px)',
                        overflowY: 'auto',
                        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        zIndex: 1000000,
                    } }>
                        <div style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } }>
                            <div style={ { display: 'flex', alignItems: 'center', gap: 10 } }>
                                <div style={ { width: 10, height: 10, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 10px #10b981' } }></div>
                                <span className="gleo-tour-step-pill" style={ { color: '#94a3b8', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.02em' } }>
                                    Step { tourState.step + 1 } of { tourState.elements.length }
                                </span>
                            </div>
                            <button type="button" onClick={ finishTourSession } style={ { background: 'transparent', border: 'none', color: '#64748b', fontSize: 24, cursor: 'pointer', padding: 0 } }>&times;</button>
                        </div>
                        <h3 className="gleo-tour-step-title" style={ { color: '#fff', margin: '0 0 10px', fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em' } }>{ tourState.elements[ tourState.step ].title }</h3>
                        { tourState.elements[ tourState.step ].text ? (
                            <p className="gleo-tour-step-blurb" style={ { color: '#94a3b8', margin: '0 0 16px', fontSize: 14, lineHeight: 1.55, fontWeight: 500 } }>
                                { tourState.elements[ tourState.step ].text }
                            </p>
                        ) : null }
                        { tourState.elements[ tourState.step ].schemaPayload && (
                            <div style={ { marginBottom: 16 } }>
                                <div style={ { fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8, textTransform: 'uppercase' } }>Injected JSON-LD</div>
                                <pre style={ { background: '#0f172a', color: '#10b981', padding: '12px', borderRadius: 12, fontSize: 11, overflowX: 'auto', maxHeight: 140, border: '1px solid rgba(255,255,255,0.1)', margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }>
                                    <code>{ JSON.stringify( tourState.elements[ tourState.step ].schemaPayload, null, 2 ) }</code>
                                </pre>
                            </div>
                        ) }
                        <div style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 } }>
                            <button type="button" className="gleo-btn" disabled={ tourState.step === 0 } onClick={ () => setTourState( p => ( { ...p, step: p.step - 1 } ) ) } style={ { background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', padding: '10px 20px', borderRadius: 12, opacity: tourState.step === 0 ? 0.3 : 1 } }>
                                Previous
                            </button>
                            <div style={ { display: 'flex', gap: 6 } }>
                                { tourState.elements.map( ( _, i ) => (
                                    <div key={ i } style={ { width: 6, height: 6, borderRadius: '50%', background: i === tourState.step ? '#10b981' : 'rgba(255,255,255,0.1)' } } />
                                ) ) }
                            </div>
                            { tourState.step < tourState.elements.length - 1 ? (
                                <button type="button" className="gleo-btn gleo-btn-primary" onClick={ () => setTourState( p => ( { ...p, step: p.step + 1 } ) ) } style={ { padding: '10px 24px', borderRadius: 12 } }>
                                    Next →
                                </button>
                            ) : (
                                <button type="button" className="gleo-btn gleo-btn-primary" onClick={ finishTourSession } style={ { padding: '10px 24px', borderRadius: 12, background: '#3b82f6', border: 'none' } }>
                                    Done
                                </button>
                            ) }
                        </div>
                    </div>
                ) }
                    </>
                ) }
            </div>
        </div>
    );
};

// ── Report Card ──────────────────────────────────────────────────────────────
const GeoReportCard = ( { report, totalReportCards = 1 } ) => {
    const { post_id, result, preview_url: previewUrl } = report;
    const canCollapse = totalReportCards >= 3;
    const [expanded, setExpanded]             = useState( () => totalReportCards < 3 );
    const [appliedTypes, setAppliedTypes]     = useState({});
    const [applyingTypes, setApplyingTypes]   = useState({});
    const [toasts, setToasts]                 = useState([]);
    const [modal, setModal]                   = useState(null);
    const [showPreview, setShowPreview]       = useState(false);
    const [isApplyingAll, setIsApplyingAll]   = useState(false);
    const [showSchema, setShowSchema]         = useState(false);
    const [optimizeStatus, setOptimizeStatus] = useState( null );
    const [geminiPolished, setGeminiPolished] = useState( false );
    const [postOptimizeCritique, setPostOptimizeCritique] = useState( null );
    const [previewMountKey, setPreviewMountKey] = useState( 0 );

    const siteUrl = typeof gleoData !== 'undefined' ? gleoData.siteUrl : '';
    const base = siteUrl ? siteUrl.replace( /\/$/, '' ) : '';
    const postUrl = previewUrl || ( base ? `${ base }/?p=${ post_id }&gleo_iframe=1` : '' );

    if (!result) return null;

    const addToast    = msg => { const id = Date.now(); setToasts(p => [...p, { id, message: msg }]); };
    const removeToast = id  => setToasts(p => p.filter(t => t.id !== id));

    const collectAutoFixTypesForItem = ( item ) => {
        const types = [];
        if ( item.fixType && FIX_CONFIG[ item.fixType ] && ! FIX_CONFIG[ item.fixType ].needsInput ) {
            types.push( item.fixType );
        }
        ( item.extraFixes || [] ).forEach( ft => {
            if ( FIX_CONFIG[ ft ] && ! FIX_CONFIG[ ft ].needsInput ) {
                types.push( ft );
            }
        } );
        return types;
    };

    const buildItems = () => {
        const items = [];
        const cs = result.content_signals || {};

        // ── 1. Technical Crawlability (15 pts) ──
        {
            let score = 0;
            if (!cs.has_meta_robots_block) score += 5;
            if (cs.alt_text_coverage >= 90 || cs.image_count === 0) score += 5;
            if (cs.has_llms_txt) score += 5;
            const issues = [];
            if (cs.has_meta_robots_block) issues.push('Remove noindex/nofollow meta tag');
            if (cs.image_count > 0 && cs.alt_text_coverage < 90) issues.push(`${cs.alt_text_coverage}% alt text coverage (aim for 90%+)`);
            if (!cs.has_llms_txt) issues.push('Re-scan to verify /llms.txt in HTML (Gleo serves it and adds a head link)');
            const msg = score === 15 ? 'All technical crawlability checks pass. AI bots can fully access your content.' : issues.join('. ') + '.';
            const techAuto = [];
            if (cs.image_count > 0 && cs.alt_text_coverage < 90) techAuto.push('image_alt_text');
            if (score < 15) techAuto.push('robots_txt_allow');
            const techAutoFiltered = techAuto.filter(ft => FIX_CONFIG[ft] && !FIX_CONFIG[ft].needsInput);
            items.push({
                priority: score === 15 ? 'positive' : score <= 5 ? 'critical' : 'medium',
                area: 'Technical Crawlability', maxScore: 15, score, message: msg,
                fixType: techAutoFiltered[0] || null,
                extraFixes: techAutoFiltered.slice(1),
                emoji: '🔍',
            });
        }

        // ── 2. Structured Data & Schema (20 pts) ──
        {
            let score = 0;
            if (cs.has_schema) score += 10;
            if (cs.has_faq_schema) score += 5;
            if (cs.has_org_schema) score += 5;
            const issues = [];
            if (!cs.has_schema) issues.push('Deploy JSON-LD schema markup');
            if (!cs.has_faq_schema) issues.push('Add FAQPage schema');
            if (!cs.has_org_schema) issues.push('Add Organization/Product schema');
            const msg = score === 20 ? 'Full schema coverage. AI engines can fully understand your content structure.' : issues.join('. ') + '.';
            let schemaPrimary = null;
            if (score < 20) {
                if (!cs.has_schema) schemaPrimary = 'schema';
                else if (!cs.has_org_schema || !cs.has_faq_schema) schemaPrimary = 'schema_enrich';
            }
            items.push({
                priority: score === 20 ? 'positive' : !cs.has_schema ? 'critical' : 'medium',
                area: 'Structured Data & Schema', maxScore: 20, score, message: msg,
                fixType: schemaPrimary,
                extraFixes: [],
                emoji: '🏗️',
            });
        }

        // ── 3. Content Quality (30 pts) ──
        {
            let score = 0;
            if (cs.word_count >= 2000) score += 10;
            else if (cs.word_count >= 1200) score += 7;
            else if (cs.word_count >= 600) score += 4;
            else if (cs.word_count > 0) score += 1;
            if (cs.has_direct_answer) score += 5;
            if (cs.has_tldr) score += 5;
            if (cs.has_conversational_queries) score += 3;
            if (cs.has_direct_answers) score += 2;
            if (cs.word_count >= 800 && cs.has_statistics) score += 3;
            if (cs.has_quotes) score += 2;
            score = Math.min(30, score);
            const issues = [];
            if (cs.word_count < 1200) issues.push(`${cs.word_count} words — aim for 1,200+`);
            if (!cs.has_direct_answer) issues.push('Add a concise “In brief” answer at the top (inverted pyramid)');
            if (!cs.has_tldr) issues.push('Add an opening “In brief” summary near the top');
            if (!cs.has_conversational_queries) issues.push('Target conversational queries');
            const msg = score >= 25 ? 'Strong content quality. Depth, direct answers, and conversational targeting are solid.' : issues.join('. ') + '.';
            const cq = [];
            if (!cs.has_direct_answer || !cs.has_tldr) cq.push('opening_summary');
            if (cs.word_count < 1200) cq.push('content_depth');
            cq.push('faq');
            const cqF = cq.filter(ft => FIX_CONFIG[ft] && !FIX_CONFIG[ft].needsInput);
            items.push({
                priority: score >= 25 ? 'positive' : score <= 10 ? 'critical' : score <= 20 ? 'high' : 'medium',
                area: 'Content Quality', maxScore: 30, score, message: msg,
                fixType: score < 25 ? cqF[0] : null,
                extraFixes: score < 25 ? cqF.slice(1) : [],
                emoji: '✍️',
            });
        }

        // ── 4. Credibility (15 pts) ──
        {
            let score = 0;
            if (cs.stat_count >= 3) score += 5;
            else if (cs.stat_count >= 1) score += 3;
            if (cs.citation_count >= 3) score += 5;
            else if (cs.citation_count >= 1) score += 3;
            if (cs.has_quotes) score += 5;
            const issues = [];
            if (cs.stat_count < 3) issues.push('Add first-party statistics and data');
            if (cs.citation_count < 3) issues.push('Link to authoritative external sources');
            if (!cs.has_quotes) issues.push('Include expert quotes or testimonials');
            const msg = score === 15 ? 'Excellent credibility signals. Statistics, citations, and expert quotes are present.' : issues.join('. ') + '.';
            const cred = [];
            if (cs.stat_count < 3) cred.push('authority');
            if (!cs.has_quotes) cred.push('expert_quotes');
            const credF = cred.filter(ft => FIX_CONFIG[ft] && !FIX_CONFIG[ft].needsInput);
            items.push({
                priority: score === 15 ? 'positive' : score <= 5 ? 'high' : 'medium',
                area: 'Credibility', maxScore: 15, score, message: msg,
                fixType: score < 15 ? credF[0] : null,
                extraFixes: score < 15 ? credF.slice(1) : [],
                emoji: '📊',
            });
        }

        // ── 5. AI-Specific Formatting (20 pts) ──
        {
            let score = 0;
            if (cs.heading_count >= 4) score += 5;
            else if (cs.heading_count >= 2) score += 3;
            else if (cs.has_headings) score += 1;
            if (cs.long_paragraphs === 0 && cs.paragraph_count > 0) score += 5;
            else if (cs.long_paragraphs <= 2) score += 3;
            if (cs.list_item_count >= 3) score += 4;
            else if (cs.has_lists) score += 2;
            if (cs.has_faq) score += 3;
            if (cs.has_table) score += 3;
            const issues = [];
            if (cs.heading_count < 4) issues.push(`${cs.heading_count} headings — add H2s every ~3 paragraphs`);
            if (cs.long_paragraphs > 0) issues.push(`${cs.long_paragraphs} long paragraph(s) to shorten`);
            if (!cs.has_lists) issues.push('Convert dense text to bulleted lists');
            if (!cs.has_faq) issues.push('Add a contextual FAQ block');
            if (!cs.has_table) issues.push('Add comparison tables');
            const msg = score === 20 ? 'Excellent AI-specific formatting. Content is fully optimized for AI extraction.' : issues.join('. ') + '.';
            items.push({
                priority: score === 20 ? 'positive' : score <= 8 ? 'high' : 'medium',
                area: 'AI-Specific Formatting', maxScore: 20, score, message: msg,
                fixType: score < 20 ? 'structure' : null,
                extraFixes: score < 20 ? ['formatting', 'readability', 'faq', 'data_tables'] : [],
                emoji: '🤖',
            });
        }

        return items.map(item => {
            const autoTypes = collectAutoFixTypesForItem(item);
            const appliedRow = autoTypes.length === 0
                ? (item.priority === 'positive')
                : autoTypes.every(ft => appliedTypes[ft]);
            const applyingRow = autoTypes.some(ft => applyingTypes[ft]);
            return { ...item, applied: appliedRow, applying: applyingRow };
        });
    };

    const allItems = buildItems();

    const doApply = (fixType, userInput) => {
        const config = FIX_CONFIG[fixType];
        setApplyingTypes(p => ({ ...p, [fixType]: true }));
        const data = { post_id, type: fixType, enabled: true };
        if (userInput !== undefined) data.user_input = userInput;
        return apiFetch({ path: '/gleo/v1/apply', method: 'POST', data })
            .then(() => { setAppliedTypes(p => ({ ...p, [fixType]: true })); addToast(config?.successMsg || `${fixType} applied.`); })
            .catch(err => { addToast(`Failed: ${err.message || 'Unknown error'}`); })
            .finally(() => setApplyingTypes(p => ({ ...p, [fixType]: false })));
    };

    const applyCategoryFixes = async ( item ) => {
        const types = collectAutoFixTypesForItem( item );
        if ( types.length === 0 ) {
            return;
        }
        let failed = false;
        for ( const ft of types ) {
            setApplyingTypes( p => ( { ...p, [ ft ]: true } ) );
            try {
                await apiFetch( { path: '/gleo/v1/apply', method: 'POST', data: { post_id, type: ft, enabled: true } } );
                await new Promise( r => setTimeout( r, 70 ) );
                setAppliedTypes( p => ( { ...p, [ ft ]: true } ) );
            } catch ( e ) {
                failed = true;
            } finally {
                setApplyingTypes( p => ( { ...p, [ ft ]: false } ) );
            }
        }
        addToast( failed ? 'Some fixes in this category failed.' : `Applied: ${ types.map( ft => FIX_CONFIG[ ft ]?.label || ft ).join( ', ' ) }` );
    };

    const handleFix = fixType => {
        const config = FIX_CONFIG[fixType];
        if (!config) return;
        if (config.needsInput) setModal({ fixType, title: config.label, prompt: config.prompt, inputType: config.inputType });
        else doApply(fixType);
    };

    const collectAllAutoFixTypes = () => {
        const allFixTypes = new Set();
        for ( const item of allItems ) {
            if ( item.fixType && ! FIX_CONFIG[ item.fixType ]?.needsInput ) {
                allFixTypes.add( item.fixType );
            }
            if ( item.extraFixes ) {
                item.extraFixes.forEach( ft => {
                    if ( FIX_CONFIG[ ft ] && ! FIX_CONFIG[ ft ].needsInput ) {
                        allFixTypes.add( ft );
                    }
                } );
            }
        }
        return [ ...allFixTypes ];
    };

    const handleApplyAll = async () => {
        setIsApplyingAll(true);
        const names = [];
        let failed = false;
        const allFixTypes = new Set( collectAllAutoFixTypes() );
        for ( const ft of allFixTypes ) {
            if ( appliedTypes[ ft ] ) {
                continue;
            }
            names.push( FIX_CONFIG[ ft ]?.label || ft );
            setApplyingTypes( p => ( { ...p, [ ft ]: true } ) );
            try {
                await apiFetch( { path: '/gleo/v1/apply', method: 'POST', data: { post_id, type: ft, enabled: true } } );
                await new Promise( r => setTimeout( r, 80 ) );
                setAppliedTypes( p => ( { ...p, [ ft ]: true } ) );
            } catch ( err ) {
                failed = true;
            } finally {
                setApplyingTypes( p => ( { ...p, [ ft ]: false } ) );
            }
        }

        if ( names.length > 0 ) {
            addToast( failed ? 'Some fixes failed.' : `Applied: ${ names.join( ', ' ) }` );
        }
        setIsApplyingAll( false );
    };

    const handleOptimizeSite = async () => {
        if ( ! postUrl ) {
            addToast( 'No preview URL for this post.' );
            return;
        }
        if ( ! showPreview ) {
            setPreviewMountKey( k => k + 1 );
            setShowPreview( true );
        }
        setPostOptimizeCritique( null );
        setGeminiPolished( false );
        setOptimizeStatus( { pct: 8, label: 'Step 1 of 3: Adding AI improvements to your page…' } );
        let anyApplyFailed = false;
        try {
            const typesArr = collectAllAutoFixTypes();
            const todo = typesArr.filter( ft => ! appliedTypes[ ft ] );
            const totalSteps = Math.max( 1, todo.length );
            let step = 0;
            for ( const ft of todo ) {
                setApplyingTypes( p => ( { ...p, [ ft ]: true } ) );
                try {
                    await apiFetch( { path: '/gleo/v1/apply', method: 'POST', data: { post_id, type: ft, enabled: true } } );
                    await new Promise( r => setTimeout( r, 80 ) );
                    setAppliedTypes( p => ( { ...p, [ ft ]: true } ) );
                } catch ( e ) {
                    anyApplyFailed = true;
                } finally {
                    setApplyingTypes( p => ( { ...p, [ ft ]: false } ) );
                }
                step++;
                const pct = Math.min( 44, 8 + Math.round( 36 * ( step / totalSteps ) ) );
                setOptimizeStatus( { pct, label: 'Step 1 of 3: Adding AI improvements to your page…' } );
            }

            setOptimizeStatus( { pct: 50, label: 'Step 2 of 3: Sending your page to Gemini for review and polish…' } );
            const polishRes = await apiFetch( { path: '/gleo/v1/gemini-polish', method: 'POST', data: { post_id } } );
            setOptimizeStatus( { pct: 90, label: 'Step 3 of 3: Saving your updated page…' } );
            setPostOptimizeCritique( polishRes?.optimize_critique || null );
            setGeminiPolished( true );
            addToast( polishRes?.message || 'Gemini finished polishing your page.' );
            if ( anyApplyFailed ) {
                addToast( 'Some quick fixes failed earlier; polish still ran on your latest saved content.' );
            }
        } catch ( err ) {
            addToast( err?.message || 'Optimize stopped because something went wrong.' );
            setGeminiPolished( false );
            setPostOptimizeCritique( null );
        } finally {
            setOptimizeStatus( null );
            setPreviewMountKey( k => k + 1 );
        }
    };

    const allAutoFixed = ( () => {
        const u = new Set();
        allItems.forEach( it => collectAutoFixTypesForItem( it ).forEach( ft => u.add( ft ) ) );
        return u.size === 0 || [ ...u ].every( ft => appliedTypes[ ft ] );
    } )();
    // Honest headline score: use analyzer GEO score from the last stored scan (never inflate from local "applied" clicks).
    const pillarSumRaw = allItems.reduce((acc, item) => acc + (item.score || 0), 0);
    const storedGeo     = typeof result.geo_score === 'number' && ! Number.isNaN(result.geo_score )
        ? Math.max(0, Math.min(100, Math.round(result.geo_score)))
        : null;
    const headlineScore = storedGeo !== null ? storedGeo : Math.min(100, pillarSumRaw);
    const issueCount   = allItems.filter(i => i.priority === 'critical' || i.priority === 'high').length;
    const showReportBody = expanded || ! canCollapse;

    return (
        <div className="gleo-report-card">
            {toasts.length > 0 && (
                <div className="gleo-toast-container">
                    {toasts.map(t => <SuccessToast key={t.id} message={t.message} onDismiss={() => removeToast(t.id)}/>)}
                </div>
            )}

            <div
                className={ `gleo-report-header${ canCollapse ? '' : ' gleo-report-header-static' }` }
                onClick={ canCollapse ? () => setExpanded( e => ! e ) : undefined }
                role={ canCollapse ? 'button' : undefined }
                tabIndex={ canCollapse ? 0 : undefined }
                onKeyDown={ canCollapse ? ev => {
                    if ( ev.key === 'Enter' || ev.key === ' ' ) {
                        ev.preventDefault();
                        setExpanded( e => ! e );
                    }
                } : undefined }
            >
                <span className={`gleo-score-chip ${scoreChipClass(headlineScore)}`}>{headlineScore}</span>
                <div className="gleo-report-title">
                    <h3>{result.title || `Post #${post_id}`}</h3>
                    {result.content_signals?.word_count !== undefined && (
                        <p className="gleo-post-meta">
                            {result.content_signals.word_count} words &middot; {issueCount} issue{issueCount !== 1 ? 's' : ''}
                            {typeof result.geo_score === 'number' && !Number.isNaN(result.geo_score) ? (
                                <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
                                    GEO score from last scan. Re-run analysis to refresh after you change the live post.
                                </span>
                            ) : null}
                        </p>
                    )}
                </div>
                { canCollapse ? <IconChevron open={expanded}/> : <span className="gleo-report-chevron-spacer" aria-hidden="true"/> }
            </div>

            <div className="gleo-report-workflow">
                <p className="gleo-workflow-label">
                    Open <strong>Preview site</strong>, then use <strong>Optimize site</strong> in the preview toolbar. That runs Gleo&apos;s quick fixes, sends the page to Gemini for polish, then shows a short AI review of the <em>optimized</em> page — only inside the preview, not here.
                </p>
                <div className="gleo-workflow-actions">
                    { postUrl ? (
                        <button type="button" className="gleo-btn gleo-btn-primary gleo-workflow-btn-preview"
                            onClick={ () => {
                                if ( showPreview ) {
                                    setShowPreview( false );
                                    return;
                                }
                                setPostOptimizeCritique( null );
                                setGeminiPolished( false );
                                setPreviewMountKey( k => k + 1 );
                                setShowPreview( true );
                            } }
                            disabled={ Boolean( optimizeStatus ) }>
                            { showPreview ? 'Close preview' : 'Preview site' }
                        </button>
                    ) : null }
                    <button type="button" className="gleo-btn gleo-btn-outline gleo-workflow-btn-apply"
                        onClick={ handleApplyAll } disabled={ allAutoFixed || isApplyingAll || Boolean( optimizeStatus ) }>
                        { isApplyingAll ? 'Applying…' : ( allAutoFixed ? 'All quick fixes applied' : 'Apply quick fixes only' ) }
                    </button>
                </div>
                <p className="gleo-workflow-hint">Fixes that need your text (like sources) stay one click each in the list below.</p>
            </div>

            { showReportBody && (
                <div className="gleo-report-body">
                    {(result.json_ld_schema || result.content_signals?.has_schema) && (
                        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '14px 16px', marginBottom: 16 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <strong style={{ color: '#0f172a', fontSize: 13.5 }}>JSON-LD (Gleo) — {result.content_signals?.has_schema ? 'detected on last scan' : 'stored payload; re-scan to confirm live HTML'}</strong>
                                <button type="button" className="gleo-btn gleo-btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}
                                    onClick={() => setShowSchema(!showSchema)}>
                                    {showSchema ? 'Hide' : 'View payload'}
                                </button>
                            </div>
                            {showSchema && (
                                <pre style={{ background: '#1e293b', color: '#34d399', padding: '12px', borderRadius: 6, fontSize: 12, overflowX: 'auto', margin: '14px 0 0' }}>
                                    <code>{JSON.stringify(result.json_ld_schema, null, 2)}</code>
                                </pre>
                            )}
                        </div>
                    )}

                    {result.content_signals && (
                        <div className="gleo-section">
                            <h4>Content Signals</h4>
                            <div className="gleo-signals-grid">
                                <Signal label="Word Count"      value={result.content_signals.word_count}/>
                                <Signal label="Alt Text"        value={`${result.content_signals.alt_text_coverage || 0}%`}  good={result.content_signals.alt_text_coverage >= 90}/>
                                <Signal label="Schema"          value={result.content_signals.has_schema ? 'Yes' : 'No'}  good={result.content_signals.has_schema}/>
                                <Signal label="Direct Answer"   value={result.content_signals.has_direct_answer ? 'Yes' : 'No'}  good={result.content_signals.has_direct_answer}/>
                                <Signal label="Headings"        value={result.content_signals.heading_count}   good={result.content_signals.heading_count >= 4}/>
                                <Signal label="Long Paras"      value={result.content_signals.long_paragraphs || 0}  good={result.content_signals.long_paragraphs === 0}/>
                                <Signal label="Lists"           value={result.content_signals.list_item_count}  good={result.content_signals.has_lists}/>
                                <Signal label="FAQ"             value={result.content_signals.has_faq ? 'Yes' : 'No'}  good={result.content_signals.has_faq}/>
                                <Signal label="Statistics"      value={result.content_signals.stat_count || 0}  good={result.content_signals.stat_count >= 3}/>
                                <Signal label="Citations"       value={result.content_signals.citation_count || 0}  good={result.content_signals.citation_count >= 3}/>
                            </div>
                        </div>
                    )}

                    <div className="gleo-section">
                        <div className="gleo-issues-header" style={{ marginBottom: 12 }}>
                            <h4 style={{ margin: 0 }}>Category Breakdown</h4>
                        </div>
                        <div className="gleo-report-table" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', border: 'none', background: 'transparent' }}>
                            {allItems.map((item, i) => {
                                const maxVal   = item.maxScore ?? 10;
                                const scoreVal = item.score != null ? item.score : null;
                                const pct      = scoreVal != null ? Math.round((scoreVal / maxVal) * 100) : 0;
                                const barColor = item.applied ? 'var(--green)'
                                               : item.priority === 'critical' ? 'var(--red)'
                                               : item.priority === 'high'     ? 'var(--amber)'
                                               : 'var(--blue)';
                                const scoreColor = item.applied ? 'var(--green)'
                                                 : item.priority === 'critical' ? 'var(--red)'
                                                 : item.priority === 'high'     ? 'var(--amber)'
                                                 : 'var(--fg-muted)';
                                return (
                                    <div key={i} className={`gleo-report-row gleo-issue-${item.priority}`} style={{ borderRadius: 8, padding: 14, margin: 0, height: '100%' }}>
                                        <div className="gleo-report-row-main">
                                            <div className="gleo-report-row-top" style={{ paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid #e2e8f0' }}>
                                                <strong className="gleo-report-area-name" style={{ fontSize: 14 }}>{item.emoji ? `${item.emoji} ` : ''}{item.area}</strong>
                                                <div className="gleo-report-score-wrap">
                                                    <span className="gleo-report-score-num" style={{ color: item.applied ? 'var(--green)' : scoreColor, fontWeight: 700 }}>
                                                        {item.applied ? maxVal : scoreVal ?? '—'}
                                                        <span className="gleo-report-score-denom" style={{ fontWeight: 500, fontSize: 12 }}>/{maxVal}</span>
                                                    </span>
                                                </div>
                                            </div>
                                            <p className="gleo-report-row-desc" style={{ fontSize: 12 }}>{item.message}</p>
                                        </div>
                                        <div className="gleo-issue-action" style={{ paddingTop: 10, display: 'flex', justifyContent: 'flex-start' }}>
                                            {item.applied ? (
                                                <span className="gleo-status-good">✓ Fixed</span>
                                            ) : item.fixType ? (
                                                <button className="gleo-btn gleo-btn-outline"
                                                    style={{ fontSize: 11, padding: '4px 12px' }}
                                                    onClick={() => applyCategoryFixes(item)}
                                                    disabled={item.applying}>
                                                    {item.applying ? 'Fixing…' : 'Autofix Category'}
                                                </button>
                                            ) : (
                                                <span className="gleo-status-good" style={{ color: item.priority === 'positive' ? 'var(--green)' : 'var(--fg-muted)' }}>
                                                    {item.priority === 'positive' ? '✓ Perfect' : 'Manual'}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {allItems.length === 0 && (
                            <p style={{ fontSize: 13, color: 'var(--fg-muted)', padding: '16px 20px' }}>No report data yet.</p>
                        )}
                    </div>
                </div>
            )}

            { showPreview && postUrl && (
                <SitePreview key={ `gleo-preview-${ post_id }-${ previewMountKey }` }
                    url={ postUrl }
                    optimizeStatus={ optimizeStatus }
                    optimizeCritique={ postOptimizeCritique }
                    geminiPolished={ geminiPolished }
                    onOptimizeSite={ handleOptimizeSite }
                    onClose={ () => {
                        setOptimizeStatus( null );
                        setPostOptimizeCritique( null );
                        setGeminiPolished( false );
                        setShowPreview( false );
                    } }
                    onApplyAll={ handleApplyAll } applyingAll={ isApplyingAll } allApplied={ allAutoFixed }/>
            ) }

            {modal && (
                <InputModal title={modal.title} prompt={modal.prompt} inputType={modal.inputType}
                    onSubmit={input => { doApply(modal.fixType, input); setModal(null); }}
                    onCancel={() => setModal(null)}/>
            )}
        </div>
    );
};

// ── Settings panel ────────────────────────────────────────────────────────────
const SettingsPanel = ({ clientId, setClientId, secretKey, setSecretKey, onSave, isSaving, saveStatus, overrideSchema, setOverrideSchema }) => (
    <div>
        <div className="gleo-page-header">
            <div>
                <h1>Settings</h1>
                <p className="gleo-page-subtitle">API credentials and plugin configuration</p>
            </div>
        </div>
        {saveStatus && <div className={`gleo-notice ${saveStatus.type}`}>{saveStatus.message}</div>}
        {seoPluginActive && (
            <div className="gleo-seo-warning" style={{ marginBottom: 16 }}>
                <strong>{seoPluginName} detected.</strong> You can override its schema with Gleo's AI-optimized version.
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input type="checkbox" id="gleo-override" checked={overrideSchema}
                        onChange={e => {
                            setOverrideSchema(e.target.checked);
                            apiFetch({ path: '/wp/v2/settings', method: 'POST', data: { gleo_override_schema: e.target.checked } });
                        }}
                        style={{ accentColor: 'var(--blue)', width: 15, height: 15, cursor: 'pointer' }}/>
                    <label htmlFor="gleo-override" style={{ fontSize: 13, color: 'var(--fg-mid)', cursor: 'pointer' }}>
                        Global schema override
                    </label>
                </div>
            </div>
        )}
        <div className="gleo-creds-panel">
            <h3>API Credentials</h3>
            <div className="gleo-field">
                <label>Client ID</label>
                <input className="gleo-input" type="text" value={clientId} onChange={e => setClientId(e.target.value)}/>
            </div>
            <div className="gleo-field">
                <label>Secret Key</label>
                <input className="gleo-input" type="password" value={secretKey} onChange={e => setSecretKey(e.target.value)}/>
            </div>
            <button className="gleo-btn gleo-btn-primary" onClick={onSave} disabled={isSaving}>
                {isSaving ? 'Saving…' : 'Save settings'}
            </button>
        </div>
    </div>
);

// ── Main App ─────────────────────────────────────────────────────────────────
const App = () => {
    const [activeTab, setActiveTab]             = useState('scan');
    const [clientId, setClientId]               = useState('');
    const [secretKey, setSecretKey]             = useState('');
    const [isSaving, setIsSaving]               = useState(false);
    const [saveStatus, setSaveStatus]           = useState(null);
    const [isScanning, setIsScanning]           = useState(false);
    const [scanProgress, setScanProgress]       = useState(0);
    const [scanTotal, setScanTotal]             = useState(0);
    const [scanCompleted, setScanCompleted]     = useState(0);
    const [estimatedProgress, setEstimatedProgress] = useState(0);
    const [scanResults, setScanResults]         = useState([]);
    const [overrideSchema, setOverrideSchema]   = useState(false);
    const [availablePosts, setAvailablePosts]   = useState([]);
    const [selectedPosts, setSelectedPosts]     = useState([]);
    const [isLoadingPosts, setIsLoadingPosts]   = useState(true);
    const [showScanModal, setShowScanModal]     = useState(false);
    const scanJustStarted                       = useRef(false);
    const scanStartedAtRef                      = useRef(null);

    useEffect(() => {
        apiFetch({ path: '/wp/v2/settings' }).then(s => {
            setClientId(s.gleo_client_id || '');
            setSecretKey(s.gleo_secret_key || '');
            setOverrideSchema(s.gleo_override_schema || false);
        });
        apiFetch({ path: '/wp/v2/posts?per_page=20&status=publish' })
            .then(posts => { setAvailablePosts(posts); setSelectedPosts(posts.slice(0, 5).map(p => p.id)); setIsLoadingPosts(false); })
            .catch(() => setIsLoadingPosts(false));
        checkScanStatus();
    }, []);

    const checkScanStatus = () => {
        apiFetch({ path: '/gleo/v1/scan/status' })
            .then(res => {
                setIsScanning(res.is_scanning);
                setScanProgress(typeof res.progress === 'number' ? res.progress : 0);
                setScanTotal(typeof res.total === 'number' ? res.total : 0);
                setScanCompleted(typeof res.completed === 'number' ? res.completed : 0);
                if (!res.is_scanning) {
                    scanStartedAtRef.current = null;
                    setEstimatedProgress(0);
                }
                if (res.results?.length > 0) {
                    setScanResults(res.results);
                    if (!res.is_scanning && scanJustStarted.current) {
                        setShowScanModal(true); scanJustStarted.current = false;
                    }
                }
                if (res.is_scanning) setTimeout(checkScanStatus, 3000);
            }).catch(() => {});
    };

    const handleSave = () => {
        setIsSaving(true); setSaveStatus(null);
        apiFetch({ path: '/wp/v2/settings', method: 'POST', data: { gleo_client_id: clientId, gleo_secret_key: secretKey } })
            .then(() => setSaveStatus({ type: 'success', message: 'Settings saved.' }))
            .catch(err => setSaveStatus({ type: 'error', message: err.message || 'Error saving.' }))
            .finally(() => setIsSaving(false));
    };

    const handleScan = () => {
        if (selectedPosts.length === 0) { setSaveStatus({ type: 'error', message: 'Select at least one post.' }); return; }
        scanJustStarted.current = true;
        scanStartedAtRef.current = Date.now();
        setIsScanning(true);
        setScanProgress(0);
        setScanTotal(0);
        setScanCompleted(0);
        setEstimatedProgress(0);
        setScanResults([]);
        setSaveStatus(null);
        apiFetch({ path: '/gleo/v1/scan/start', method: 'POST', data: { post_ids: selectedPosts } })
            .then(res => { setSaveStatus({ type: 'success', message: res.message }); checkScanStatus(); })
            .catch(err => { setSaveStatus({ type: 'error', message: err.message || 'Error starting scan.' }); setIsScanning(false); });
    };

    useEffect(() => {
        if ( ! isScanning ) {
            return undefined;
        }
        const tick = () => {
            if ( ! scanStartedAtRef.current ) {
                scanStartedAtRef.current = Date.now();
            }
            const elapsedMs = Date.now() - scanStartedAtRef.current;
            const expectedTotal = scanTotal > 0 ? scanTotal : Math.max( 1, selectedPosts.length || 1 );
            const perPostMs = 15000;
            const finishedPct = ( scanCompleted / expectedTotal ) * 100;
            const msIntoCurrent = Math.max( 0, elapsedMs - ( scanCompleted * perPostMs ) );
            const partialPct = Math.min( 1, msIntoCurrent / perPostMs ) * ( 100 / expectedTotal );
            const est = Math.min( 99, finishedPct + partialPct );
            setEstimatedProgress( p => Math.max( p, est ) );
        };
        tick();
        const id = setInterval( tick, 250 );
        return () => clearInterval( id );
    }, [ isScanning, scanCompleted, scanTotal, selectedPosts.length ] );

    const siteHostname = typeof gleoData !== 'undefined' ? (() => { try { return new URL(gleoData.siteUrl).hostname; } catch(e) { return 'your site'; } })() : 'your site';

    const scannedPostIds = useMemo( () => new Set( ( scanResults || [] ).map( r => r.post_id ) ), [ scanResults ] );
    const avgGeoScore = scanResults.length
        ? Math.round( scanResults.reduce( ( s, r ) => s + ( r.result?.geo_score || 0 ), 0 ) / scanResults.length )
        : null;
    const postsUnscanned = useMemo( () => {
        if ( ! availablePosts.length ) {
            return 0;
        }
        return availablePosts.filter( p => ! scannedPostIds.has( p.id ) ).length;
    }, [ availablePosts, scannedPostIds ] );
    const criticalIssuesCount = scanResults.reduce( ( s, r ) =>
        s + ( r.result?.recommendations || [] ).filter( rec => rec.priority === 'critical' ).length, 0 );

    return (
        <div className="gleo-dashboard">
            {/* Sidebar */}
            <aside className="gleo-sidebar">
                <div className="gleo-sidebar-top">
                    <div className="gleo-logo">gl<em>eo</em></div>
                    <div className="gleo-workspace">
                        <span className="gleo-ws-dot"></span>
                        <span className="gleo-ws-name">{siteHostname}</span>
                    </div>
                </div>
                <nav className="gleo-nav">
                    <div className="gleo-nav-group">Optimize</div>
                    <div className={`gleo-nav-item ${activeTab === 'scan' ? 'active' : ''}`} onClick={() => setActiveTab('scan')}>
                        <IconScan/>
                        Dashboard
                    </div>
                    <div className={`gleo-nav-item ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
                        <IconAnalytics/>
                        Analytics
                    </div>
                    <div className="gleo-nav-group">Account</div>
                    <div className={`gleo-nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
                        <IconSettings/>
                        Settings
                    </div>
                </nav>
            </aside>

            {/* Main content */}
            <main className="gleo-main">

                {/* Analysis (formerly Scan + Dashboard merged) */}
                {activeTab === 'scan' && (
                    <div>
                        <div className="gleo-page-header">
                            <div>
                                <h1>Dashboard</h1>
                                <p className="gleo-page-subtitle">AI search optimization for {siteHostname}</p>
                            </div>
                            { scanResults.length > 0 && (
                                <div className="gleo-header-actions">
                                    <button type="button" className="gleo-btn gleo-btn-outline" onClick={ () => setActiveTab( 'analytics' ) }>View Analytics</button>
                                </div>
                            ) }
                        </div>

                        <div className="gleo-metrics-strip" style={ { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14, marginBottom: 22 } }>
                            <div className="gleo-card" style={ { marginBottom: 0 } }>
                                <div className="gleo-card-body" style={ { padding: '18px 20px' } }>
                                    <div style={ { fontSize: 34, fontWeight: 800, color: 'var(--blue)', letterSpacing: -1, lineHeight: 1.1 } }>{ avgGeoScore !== null ? avgGeoScore : '—' }</div>
                                    <p style={ { fontSize: 13, color: 'var(--fg-muted)', margin: '10px 0 0' } }>Avg GEO score</p>
                                </div>
                            </div>
                            <div className="gleo-card" style={ { marginBottom: 0 } }>
                                <div className="gleo-card-body" style={ { padding: '18px 20px' } }>
                                    <div style={ { fontSize: 34, fontWeight: 800, color: 'var(--fg)', letterSpacing: -1, lineHeight: 1.1 } }>{ postsUnscanned }</div>
                                    <p style={ { fontSize: 13, color: 'var(--fg-muted)', margin: '10px 0 0' } }>Posts unscanned</p>
                                </div>
                            </div>
                            <div className="gleo-card" style={ { marginBottom: 0 } }>
                                <div className="gleo-card-body" style={ { padding: '18px 20px' } }>
                                    <div style={ { fontSize: 34, fontWeight: 800, color: criticalIssuesCount > 0 ? 'var(--red)' : 'var(--green)', letterSpacing: -1, lineHeight: 1.1 } }>{ criticalIssuesCount }</div>
                                    <p style={ { fontSize: 13, color: 'var(--fg-muted)', margin: '10px 0 0' } }>Critical issues</p>
                                </div>
                            </div>
                        </div>

                        {saveStatus && <div className={`gleo-notice ${saveStatus.type}`}>{saveStatus.message}</div>}

                        {/* Results — shown once results exist */}
                        {scanResults.length > 0 && (
                            <>
                                <div className="gleo-section-label" style={{ marginBottom: 10 }}>
                                    Results — {scanResults.length} post{scanResults.length !== 1 ? 's' : ''}
                                </div>
                                { scanResults.map( r => (
                                    <GeoReportCard key={ r.post_id } report={ r } totalReportCards={ scanResults.length }/>
                                ) ) }
                            </>
                        )}

                        {/* Post selection + scan trigger */}
                        <div className="gleo-card" style={{ marginBottom: 24, marginTop: scanResults.length > 0 ? 24 : 0 }}>
                            <div className="gleo-card-header">
                                <h3>Select posts to analyze</h3>
                                <span className="gleo-card-meta">{selectedPosts.length} selected</span>
                            </div>
                            <div className="gleo-card-body">
                                {isLoadingPosts ? (
                                    <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Loading posts…</p>
                                ) : (
                                    <div className="gleo-post-list">
                                        {availablePosts.map(post => (
                                            <div key={post.id} className="gleo-post-item"
                                                onClick={() => setSelectedPosts(p => p.includes(post.id) ? p.filter(id => id !== post.id) : [...p, post.id])}>
                                                <input type="checkbox" checked={selectedPosts.includes(post.id)} onChange={() => {}}/>
                                                <label>{post.title.rendered || `Post #${post.id}`}</label>
                                            </div>
                                        ))}
                                        {availablePosts.length === 0 && (
                                            <p style={{ padding: 8, fontSize: 13, color: 'var(--fg-muted)' }}>No published posts found.</p>
                                        )}
                                    </div>
                                )}
                                <button className="gleo-btn gleo-btn-primary"
                                    style={{ padding: '9px 24px', fontSize: 13.5, marginTop: 12 }}
                                    onClick={handleScan} disabled={isScanning || selectedPosts.length === 0}>
                                    {isScanning ? 'Analyzing posts…' : `Analyze ${selectedPosts.length} post${selectedPosts.length !== 1 ? 's' : ''}`}
                                </button>
                                { isScanning && (
                                    <div style={ { marginTop: 16, display: 'flex', alignItems: 'center', gap: 14 } }>
                                        <div className="gleo-spinner" style={ { width: 28, height: 28, flexShrink: 0 } } />
                                        <div>
                                            <div style={ { fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' } }>Analyzing your posts…</div>
                                            <div style={ { fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4 } }>
                                                { scanTotal > 0 ? `Finished ${ scanCompleted } of ${ scanTotal }. This can take a little while.` : 'Starting…' }
                                            </div>
                                        </div>
                                    </div>
                                ) }
                            </div>
                        </div>

                        {showScanModal && (
                            <ScanCompleteModal onClose={ () => setShowScanModal( false ) }/>
                        )}
                    </div>
                )}

                { activeTab === 'analytics' && <AnalyticsTab/> }

                {/* Settings */}
                {activeTab === 'settings' && (
                    <SettingsPanel
                        clientId={clientId} setClientId={setClientId}
                        secretKey={secretKey} setSecretKey={setSecretKey}
                        onSave={handleSave} isSaving={isSaving} saveStatus={saveStatus}
                        overrideSchema={overrideSchema} setOverrideSchema={setOverrideSchema}/>
                )}
            </main>
        </div>
    );
};

document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('gleo-admin-app');
    if (root) render(<App/>, root);
});
