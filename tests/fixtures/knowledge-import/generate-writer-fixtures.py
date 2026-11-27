"""Regenerates the third-party XLSX fixtures for the Knowledge Importer parser tests.

The workbooks follow the v2 template contract (13 entity sheets plus Instructions) and hold fictional data for a
digital agency. They are written by two common libraries so the parser is tested against their real package layouts:

- openpyxl: inline strings, including the shapes read-excel-file rejects on its own: a styled empty string
  (`<c s="1" t="inlineStr"></c>`, as in the EMN test workbook at Competitors!D2) and rich text (`<is><r>...</r></is>`).
- xlsxwriter: shared strings, including a rich shared string.

Run from the repository root:  python3 tests/fixtures/knowledge-import/generate-writer-fixtures.py
"""
from datetime import date
from pathlib import Path

import openpyxl
import xlsxwriter
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont
from openpyxl.styles import Font

HERE = Path(__file__).parent
TEMPLATE = HERE / 'outvexa-outreach-brain-template-v2.xlsx'

COMPANY = 'Brightline Digital Studio'
ROWS = {
    'Company_Profile': [{
        'externalId': 'company-brightline', 'name': COMPANY,
        'description': 'Brightline is a digital marketing and web development agency for growing service businesses.',
        'website': 'https://brightline.example', 'positioning': 'Growth partner for clinics, real estate and education brands',
        'industries': 'Healthcare, Real estate, Education', 'geography': 'India, United Kingdom',
        'businessModel': 'Monthly retainers and fixed-scope projects', 'differentiators': 'In-house video team, Weekly reporting',
        'companySize': 24,
    }],
    'Services': [
        {'externalId': 'svc-meta-ads', 'name': 'Meta Ads management', 'description': 'RICH',
         'customerProblems': 'Rising cost per lead, Inconsistent lead quality', 'deliverables': 'Campaign setup, Creative testing, Weekly report',
         'targetIndustries': 'Healthcare, Real estate', 'relatedAudienceIds': 'aud-clinics'},
        {'externalId': 'svc-seo', 'name': 'SEO strategy', 'description': 'Technical and content SEO for service websites.',
         'methodology': 'Audit, roadmap, monthly sprints', 'availability': 'Two new clients per month'},
    ],
    'Commercial_Offers': [
        {'externalId': 'offer-growth', 'name': 'Growth retainer', 'description': 'Paid social and SEO on one monthly plan.',
         'price': 1500, 'currency': 'USD', 'billingModel': 'Monthly', 'duration': '6 months', 'relatedServiceIds': 'svc-meta-ads, svc-seo'},
    ],
    'Target_Audiences': [
        {'externalId': 'aud-clinics', 'name': 'Private clinics', 'description': 'Multi-location aesthetic and dental clinics.',
         'industries': 'Healthcare', 'companySize': '10-200', 'geography': 'India', 'challenges': 'Unpredictable patient bookings'},
    ],
    'Target_Personas': [
        {'externalId': 'persona-owner', 'name': 'Clinic owner', 'description': 'Founder who signs off marketing spend.',
         'jobTitles': 'Founder, Medical director', 'seniority': 'Owner', 'relatedAudienceIds': 'aud-clinics'},
    ],
    'ICP_Criteria': [
        {'externalId': 'icp-clinics', 'name': 'Established clinics', 'description': 'Clinics ready for paid acquisition.',
         'requiredConditions': 'Website live, At least two locations', 'negativeConditions': 'No budget for advertising',
         'weight': 0.6, 'threshold': 70, 'category': 'Firmographic'},
    ],
    'Business_Opportunities': [
        {'externalId': 'opp-video', 'name': 'Short video demand', 'description': 'Clinics want reels without an in-house team.',
         'marketSignals': 'Job posts for video editors', 'status': 'Open'},
    ],
    'Competitors': [
        {'externalId': 'comp-northstar', 'name': 'Northstar Media', 'description': 'Regional performance agency.',
         'positioning': '', 'website': 'https://northstar.example', 'services': 'Paid search, Paid social'},
    ],
    'Research_Rules': [
        {'externalId': 'research-recent', 'name': 'Recent signals first', 'description': 'Prefer evidence from the last 90 days.',
         'sources': 'Company website, News', 'depth': 'Standard', 'recencyRequirement': '90 days'},
    ],
    'Outreach_Rules': [
        {'externalId': 'outreach-tone', 'name': 'Plain and specific', 'description': 'Short messages that name one concrete pain point.',
         'tone': 'Friendly, direct', 'prohibitedLanguage': 'Guaranteed results', 'wordLimits': '90 words'},
    ],
    'Exclusions': [
        {'externalId': 'excl-competitors', 'name': 'Other agencies', 'description': 'Do not contact marketing agencies.',
         'companyTypes': 'Marketing agency', 'reason': 'Competitors', 'activeStatus': True},
    ],
    'Proof_Case_Studies': [
        {'externalId': 'case-dental', 'name': 'Dental group bookings', 'description': 'Paid social for a three-location dental group.',
         'client': 'Anonymised dental group', 'results': 'More consultation bookings', 'timePeriod': date(2026, 3, 31),
         'publicationPermission': False, 'relatedServiceIds': 'svc-meta-ads'},
    ],
    'Campaign_Preferences': [
        {'externalId': 'camp-q1', 'name': 'Clinic outreach Q1', 'description': 'Email outreach to clinic owners.',
         'objective': 'Book discovery calls', 'channels': 'Email', 'volumeConstraints': '40 per day'},
    ],
}


def rich_description():
    return CellRichText(['Full-funnel ', TextBlock(InlineFont(b=True), 'Meta Ads'), ' management for local service brands.'])


def write_openpyxl(path: Path):
    workbook = openpyxl.load_workbook(TEMPLATE)
    for sheet, rows in ROWS.items():
        worksheet = workbook[sheet]
        headers = [cell.value for cell in worksheet[1]]
        for offset, row in enumerate(rows, start=2):
            for column, header in enumerate(headers, start=1):
                if header not in row:
                    continue
                value = row[header]
                cell = worksheet.cell(row=offset, column=column, value=rich_description() if value == 'RICH' else value)
                if value == '':
                    cell.font = Font(bold=True)  # a styled empty string: <c s="1" t="inlineStr"></c>
    workbook.save(path)


def write_xlsxwriter(path: Path):
    template = openpyxl.load_workbook(TEMPLATE)
    workbook = xlsxwriter.Workbook(str(path))
    bold = workbook.add_format({'bold': True})
    for source in template.worksheets:
        worksheet = workbook.add_worksheet(source.title)
        for row_index, row in enumerate(source.iter_rows(values_only=True)):
            for column, value in enumerate(row):
                if value is not None:
                    worksheet.write(row_index, column, value)
        if source.title == 'Instructions':
            continue
        headers = [cell.value for cell in source[1]]
        for offset, row in enumerate(ROWS[source.title], start=1):
            for column, header in enumerate(headers):
                if header not in row:
                    continue
                value = row[header]
                if value == 'RICH':
                    worksheet.write_rich_string(offset, column, 'Full-funnel ', bold, 'Meta Ads', ' management for local service brands.')
                elif isinstance(value, date):
                    worksheet.write_datetime(offset, column, value, workbook.add_format({'num_format': 'yyyy-mm-dd'}))
                elif value != '':
                    worksheet.write(offset, column, value)
    workbook.close()


if __name__ == '__main__':
    write_openpyxl(HERE / 'openpyxl-agency-workbook.xlsx')
    write_xlsxwriter(HERE / 'xlsxwriter-agency-workbook.xlsx')
