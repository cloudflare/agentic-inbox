import { describe, expect, it } from "vitest";
import { parseDmarcXml } from "../../workers/dmarc/parser";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>12345678901234567890</report_id>
    <date_range>
      <begin>1700000000</begin>
      <end>1700086400</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>reject</p>
    <sp>reject</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.1</source_ip>
      <count>42</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
    <auth_results>
      <dkim><domain>example.com</domain><result>pass</result></dkim>
      <spf><domain>example.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.42</source_ip>
      <count>7</count>
      <policy_evaluated>
        <disposition>reject</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
  </record>
</feedback>`;

describe("parseDmarcXml", () => {
	it("parses top-level metadata", () => {
		const r = parseDmarcXml(SAMPLE);
		expect(r.org_name).toBe("google.com");
		expect(r.report_id).toBe("12345678901234567890");
		expect(r.date_range_begin).toBe("1700000000");
		expect(r.date_range_end).toBe("1700086400");
		expect(r.policy_domain).toBe("example.com");
		expect(r.policy_p).toBe("reject");
	});

	it("parses each <record> into a DmarcRecord", () => {
		const r = parseDmarcXml(SAMPLE);
		expect(r.records).toHaveLength(2);
		expect(r.records[0]).toMatchObject({
			source_ip: "203.0.113.1",
			count: 42,
			disposition: "none",
			dkim_result: "pass",
			spf_result: "pass",
			header_from: "example.com",
		});
		expect(r.records[1]).toMatchObject({
			source_ip: "198.51.100.42",
			count: 7,
			disposition: "reject",
			dkim_result: "fail",
			spf_result: "fail",
		});
	});

	it("caps `count` at 1,000,000 to guard against crafted reports", () => {
		const xml = `<feedback><record><row><source_ip>1.2.3.4</source_ip><count>999999999</count></row></record></feedback>`;
		const r = parseDmarcXml(xml);
		expect(r.records[0].count).toBeLessThanOrEqual(1_000_000);
	});

	it("returns count=0 when the value is malformed", () => {
		const xml = `<feedback><record><row><source_ip>1.2.3.4</source_ip><count>abc</count></row></record></feedback>`;
		const r = parseDmarcXml(xml);
		expect(r.records[0].count).toBe(0);
	});

	it("drops records that lack a source_ip", () => {
		const xml = `<feedback><record><row><count>10</count></row></record></feedback>`;
		const r = parseDmarcXml(xml);
		expect(r.records).toEqual([]);
	});

	it("handles empty <feedback/> without throwing", () => {
		expect(() => parseDmarcXml("<feedback></feedback>")).not.toThrow();
	});
});
