import { gql } from "@apollo/client";

const EVENTS = gql`
  query Events {
    allEvent {
      _id
      title
      startsAt
      venue
    }
  }
`;

export default function Events() {
  return <p>{String(EVENTS)}</p>;
}
