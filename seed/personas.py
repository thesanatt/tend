"""Fictional demo personas. Each one gets the same bank history; only the person's state changes.

Names, street addresses, employers, merchants and the hospital are invented. Cities and ZIP codes
are real so distances and state law make sense. Phone numbers use the 555-01xx range that is
reserved for fiction.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Persona:
    id: str
    first_name: str
    last_name: str
    jurisdiction: str
    state_name: str
    street_number: str
    street_name: str
    city: str
    zip: str
    lat: float
    lng: float
    area_code: str
    merchant_streets: tuple[str, ...]

    @property
    def display_name(self) -> str:
        return f"{self.first_name} {self.last_name}"

    @property
    def address(self) -> dict[str, str]:
        return {"street_number": self.street_number, "street_name": self.street_name, "city": self.city,
                "state": self.jurisdiction, "zip": self.zip}


PERSONAS: dict[str, Persona] = {p.id: p for p in (
    Persona("rowan-mi", "Rowan", "Hale", "MI", "Michigan", "214", "Alder Row", "Ann Arbor", "48104",
            42.2808, -83.7430, "734",
            ("Quarry Bend Rd", "Hollis Ct", "Tamarack St", "Wexley Ave", "Orchard Spur")),
    Persona("rowan-ny", "Rowan", "Hale", "NY", "New York", "88", "Linden Terrace", "Rochester", "14607",
            43.1566, -77.6088, "585",
            ("Brackett Ln", "Sumner Pl", "Gilder St", "Pennfield Ave", "Kestrel Way")),
    Persona("rowan-ca", "Rowan", "Hale", "CA", "California", "1730", "Sorrel Way", "Sacramento", "95816",
            38.5816, -121.4944, "916",
            ("Arroyo Bend", "Caldera St", "Mission Fig Ln", "Tule Ave", "Saltgrass Ct")),
    Persona("rowan-tx", "Rowan", "Hale", "TX", "Texas", "402", "Pecan Hollow Dr", "Austin", "78704",
            30.2672, -97.7431, "512",
            ("Mesquite Bend", "Caliche Rd", "Bluestem Ln", "Lantana Ave", "Limestone Ct")),
)}

MAIN_PERSONA = "rowan-mi"


def get_persona(persona_id: str) -> Persona:
    if persona_id not in PERSONAS:
        raise ValueError(f"unknown persona {persona_id!r}; choose from {', '.join(PERSONAS)}")
    return PERSONAS[persona_id]
