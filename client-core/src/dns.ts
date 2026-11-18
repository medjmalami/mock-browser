import dns from 'node:dns';
import type { DnsRecord } from './types.js';

function record(name: string, type: string, data: string, ttl: number | null = null): DnsRecord {
  return { name, class: 'IN', ttl, type, data };
}

export async function resolveRecords(name: string): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  const tasks: Array<Promise<void>> = [
    dns.promises.resolve4(name, { ttl: true }).then((values) => values.forEach((value) => records.push(record(name, 'A', value.address, value.ttl)))).catch(() => undefined),
    dns.promises.resolve6(name, { ttl: true }).then((values) => values.forEach((value) => records.push(record(name, 'AAAA', value.address, value.ttl)))).catch(() => undefined),
    dns.promises.resolveCname(name).then((values) => values.forEach((value) => records.push(record(name, 'CNAME', value)))).catch(() => undefined),
    dns.promises.resolveMx(name).then((values) => values.forEach((value) => records.push(record(name, 'MX', `${value.priority} ${value.exchange}`)))).catch(() => undefined),
    dns.promises.resolveNs(name).then((values) => values.forEach((value) => records.push(record(name, 'NS', value)))).catch(() => undefined),
    dns.promises.reverse(name).then((values) => values.forEach((value) => records.push(record(name, 'PTR', value)))).catch(() => undefined),
    dns.promises.resolveSoa(name).then((value) => {
      records.push(record(name, 'SOA', `${value.nsname} ${value.hostmaster} ${value.serial} ${value.refresh} ${value.retry} ${value.expire} ${value.minttl}`));
    }).catch(() => undefined),
  ];
  await Promise.all(tasks);
  return records.sort((left, right) => left.type.localeCompare(right.type) || left.data.localeCompare(right.data));
}
