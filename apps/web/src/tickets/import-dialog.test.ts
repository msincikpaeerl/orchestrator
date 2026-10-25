import { describe, expect, it } from 'vitest';
import { problemPlace } from './import-dialog';

describe('problemPlace', () => {
  it('names the ticket by its position and key, then the field', () => {
    expect(problemPlace({ position: 2, key: 'contact', field: 'title', message: '' })).toBe(
      'Ticket 2 “contact”, field title',
    );
    expect(problemPlace({ position: 3, key: null, field: null, message: '' })).toBe('Ticket 3');
    expect(problemPlace({ position: null, key: null, field: 'format', message: '' })).toBe(
      'The file, field format',
    );
    expect(problemPlace({ position: null, key: null, field: null, message: '' })).toBe('The file');
  });
});
