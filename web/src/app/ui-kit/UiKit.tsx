'use client';

import { useState, type ReactNode } from 'react';
import {
  Address,
  AmountInput,
  Badge,
  Button,
  ButtonLink,
  Chip,
  Delta,
  Field,
  IconButton,
  Input,
  Kv,
  Meter,
  Modal,
  Panel,
  PanelBody,
  PanelHeader,
  Segmented,
  Select,
  Skeleton,
  Stat,
  Table,
  Tabs,
  Textarea,
  Tooltip,
  useToast,
} from '@/components/ui';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <PanelBody style={{ display: 'grid', gap: 16 }}>{children}</PanelBody>
    </Panel>
  );
}

const Row = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</div>
);

const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);

export function UiKit() {
  const [unit, setUnit] = useState<'usd' | 'eth'>('usd');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [tab, setTab] = useState<'trades' | 'holders' | 'modules'>('trades');
  const [chip, setChip] = useState('trending');
  const [amount, setAmount] = useState('0.1');
  const [open, setOpen] = useState(false);
  const [curve, setCurve] = useState(64);
  const toast = useToast();

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 20px 64px', display: 'grid', gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em' }}>UI kit</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--fg-muted)' }}>
          v2 primitives from <code>src/components/ui</code>. Flip the theme in the header to check dark.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        <Section title="Buttons">
          <Row>
            <Button variant="primary">Launch a token</Button>
            <Button>Secondary</Button>
            <Button variant="ink">Connect wallet</Button>
            <Button variant="ghost">Ghost</Button>
          </Row>
          <Row>
            <Button variant="buy">Buy</Button>
            <Button variant="sell">Sell</Button>
            <Button disabled>Disabled</Button>
            <Button variant="primary" loading>
              Confirming
            </Button>
          </Row>
          <Row>
            <Button size="sm">Small</Button>
            <Button size="lg" variant="primary">
              Large
            </Button>
            <IconButton label="Search">{SearchIcon}</IconButton>
            <ButtonLink href="/discover" variant="ghost">
              Link button
            </ButtonLink>
          </Row>
        </Section>

        <Section title="Choice">
          <Segmented
            label="Price unit"
            value={unit}
            onChange={setUnit}
            options={[
              { value: 'usd', label: 'USD' },
              { value: 'eth', label: 'ETH' },
            ]}
          />
          <Segmented
            label="Side"
            block
            size="lg"
            value={side}
            onChange={setSide}
            options={[
              { value: 'buy', label: 'Buy', tone: 'buy' },
              { value: 'sell', label: 'Sell', tone: 'sell' },
            ]}
          />
          <Tabs
            label="Activity"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'trades', label: 'Trades', count: 212 },
              { value: 'holders', label: 'Holders', count: 88 },
              { value: 'modules', label: 'Modules', count: 3 },
            ]}
          />
          <Row>
            {['trending', 'new', 'near graduation', 'graduated'].map((c) => (
              <Chip key={c} pressed={chip === c} onClick={() => setChip(c)}>
                {c[0].toUpperCase() + c.slice(1)}
              </Chip>
            ))}
          </Row>
        </Section>

        <Section title="Fields">
          <Field label="Name" aside="10 / 32" htmlFor="kit-name">
            <Input id="kit-name" placeholder="urufu PEPE" />
          </Field>
          <Field label="Ticker" error="Ticker is already taken" htmlFor="kit-ticker">
            <Input id="kit-ticker" defaultValue="PEPE" invalid />
          </Field>
          <Field label="Description" aside="Optional" hint="Shown on your token page." htmlFor="kit-desc">
            <Textarea id="kit-desc" rows={3} placeholder="What is this token about?" />
          </Field>
          <Field label="Sort" htmlFor="kit-sort">
            <Select id="kit-sort" defaultValue="mcap">
              <option value="mcap">Market cap</option>
              <option value="new">Newest</option>
            </Select>
          </Field>
        </Section>

        <Section title="Amount">
          <AmountInput
            label="You pay"
            balance="Balance 1.284 ETH"
            asset="ETH"
            sub={`$${((parseFloat(amount) || 0) * 3420).toFixed(2)}`}
            inputProps={{ value: amount, onChange: (e) => setAmount(e.target.value) }}
          />
          <AmountInput label="You receive" asset="UPEPE" readOnlyValue="5.11M" />
          <Row>
            {['0.05', '0.1', '0.25', '0.5', '1'].map((v) => (
              <Chip key={v} className="ui-num" onClick={() => setAmount(v)}>
                {v}
              </Chip>
            ))}
          </Row>
        </Section>

        <Section title="Data">
          <Row>
            <Stat size="lg" label="Price" value="$0.0₄320" delta={<Delta value={18.4} />} />
            <Stat label="Market cap" value="$25.6K" />
            <Stat label="24h" value="3.10 ETH" delta={<Delta value={-3.6} />} />
          </Row>
          <Row>
            <Badge tone="accent" dot>
              Bonding curve
            </Badge>
            <Badge tone="buy" dot>
              Graduated
            </Badge>
            <Badge tone="sell">Paused</Badge>
            <Badge tone="warn">Whitelist only</Badge>
            <Badge tone="info">DN404</Badge>
            <Badge>Creator</Badge>
          </Row>
          <dl style={{ margin: 0 }}>
            <Kv label="Trading fee">
              <span className="ui-num">1%</span>
            </Kv>
            <Kv label="Contract">
              <Address value="0x803b95cf1db535089b31eb24c268e0a57b6ef29c" />
            </Kv>
          </dl>
        </Section>

        <Section title="Progress + loading">
          <Meter value={curve} size="lg" label="Bonding curve progress" />
          <Meter value={100} tone="buy" label="Graduated" />
          <Row>
            <Button size="sm" onClick={() => setCurve((c) => Math.max(0, c - 15))}>
              −15
            </Button>
            <Button size="sm" onClick={() => setCurve((c) => Math.min(100, c + 15))}>
              +15
            </Button>
            <span className="ui-num" style={{ color: 'var(--fg-muted)' }}>
              {curve}%
            </span>
          </Row>
          <div style={{ display: 'grid', gap: 8 }}>
            <Skeleton height={18} width="60%" />
            <Skeleton height={12} />
            <Skeleton height={12} width="80%" />
          </div>
        </Section>

        <Section title="Overlays">
          <Row>
            <Button onClick={() => setOpen(true)}>Open modal</Button>
            <Button onClick={() => toast({ title: 'Bought 5.11M UPEPE', description: 'for 0.1 ETH', tone: 'buy' })}>Toast</Button>
            <Tooltip content="At 4.20 ETH the token moves to Uniswap v4.">
              <Button variant="ghost">Hover me</Button>
            </Tooltip>
          </Row>
        </Section>
      </div>

      <Panel>
        <PanelHeader title="Table" />
        <Table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th data-align="right">Price</th>
              <th data-align="right">ETH</th>
              <th>Wallet</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['12s', 'buy', '$0.0₄320', '0.1208'],
              ['40s', 'sell', '$0.0₄318', '0.0188'],
              ['1m', 'buy', '$0.0₄312', '0.2204'],
            ].map(([t, s, p, e]) => (
              <tr key={t}>
                <td style={{ color: 'var(--fg-faint)' }}>{t}</td>
                <td className={s === 'buy' ? 'ui-up' : 'ui-down'} style={{ fontWeight: 700, fontSize: 12 }}>
                  {s === 'buy' ? 'Buy' : 'Sell'}
                </td>
                <td data-align="right" className="ui-num">
                  {p}
                </td>
                <td data-align="right" className={`ui-num ${s === 'buy' ? 'ui-up' : 'ui-down'}`}>
                  {e}
                </td>
                <td>
                  <Address value="0x142f00000000000000000000000000000000a0e7" />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="Max slippage">
        <p style={{ margin: '0 0 12px', color: 'var(--fg-muted)' }}>Your trade fails instead of filling at a worse price than this.</p>
        <Segmented
          label="Slippage"
          block
          value="2"
          onChange={() => {}}
          options={[
            { value: '0.5', label: '0.5%' },
            { value: '1', label: '1%' },
            { value: '2', label: '2%' },
            { value: '5', label: '5%' },
          ]}
        />
        <div style={{ marginTop: 16 }}>
          <Button variant="ink" block onClick={() => setOpen(false)}>
            Save
          </Button>
        </div>
      </Modal>
    </div>
  );
}
