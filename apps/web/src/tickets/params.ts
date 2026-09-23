import { useParams } from 'react-router';

/** The ticket number of the address (`/projects/WEB/tickets/12`), or null. */
export function useTicketNumber(): number | null {
  const { number = '' } = useParams();
  return /^[1-9]\d{0,9}$/.test(number) ? Number(number) : null;
}
